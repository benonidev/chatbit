import {Profile} from "../domain/profile.js";
import {importJoinSecret, inviteCode, joinWindow, joinWindowEnd, memberCode} from "./join_code.js";
import {epochKeys} from "./room_crypto.js";
import {logger} from "./log.js";

const log = logger("keys");

// Minimum length of the password that protects the local profile (register and change)
export const MIN_PASSWORD_LENGTH = 8;

// Holds the unlocked key material in memory only:
//  - the master key, derived from the user password (PBKDF2 via AesAdapter)
//  - the decrypted secrets of the rooms: base {G, inviterId, identity, invites} and the keys of
//    every epoch {K, J, roster} (see docs/room-keys.md) — stored encrypted with the master key
// register() creates the profile, unlock() verifies the password by decrypting profile.verify.
export class KeyStore {
    constructor(aes, db, events) {
        this._aes       = aes;
        this._db        = db;
        this._events    = events;
        this._masterKey = null;        // derived from password
        this._bases     = new Map();   // roomId → base (cache)
        this._epochs    = new Map();   // "roomId:epoch" → epoch with derived keys (cache)
        this.uid        = null;
        this.clientId   = null;
    }

    isUnlocked()       { return this._masterKey !== null; }

    lock() {
        this._masterKey = null;
        this._bases.clear();
        this._epochs.clear();
        this.uid = null;
        this.clientId = null;
    }

    init() {}

    async register(alias, password){
        const salt = await crypto.getRandomValues(new Uint8Array(16));

        let profile = new Profile({
            name: alias,
            salt: salt,
        });

        this.uid = profile.uid;
        this.clientId = profile.clientId;

        this._masterKey = await this._aes.deriveKey(password, salt);

        profile.verify = await this._aes.encrypt(this.uid, this._masterKey);

        await this._db.addProfile(profile);
    }

    async unlock(password) {
        const profile = await this._db.getProfile();

        const salt = new Uint8Array(profile.salt);

        let key;

        try {
            key = await this._aes.deriveKey(password, salt);

            const verifyResult = await this._aes.decrypt(profile.verify, key)

            if (verifyResult !== profile.uid) return false;
        } catch (err) {
            log.debug("unlock failed:", err.name); // wrong password — no error

            return false
        }

        this._masterKey = key;

        this.uid = profile.uid;

        this.clientId = profile.clientId;

        log.info("unlocked");

        return true;

    }

    // Re-encrypts everything that depends on the master key (profile check value, room names,
    // room and epoch secrets, system messages) with a key derived from the new password. Returns
    // false if the current password is wrong. Messages are encrypted with the room keys and stay
    // untouched.
    async changePassword(currentPassword, newPassword) {
        const profile = await this._db.getProfile();

        let currentKey;
        try {
            currentKey = await this._aes.deriveKey(currentPassword, new Uint8Array(profile.salt));
            if (await this._aes.decrypt(profile.verify, currentKey) !== profile.uid) return false;
        } catch {
            return false;
        }

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const newKey = await this._aes.deriveKey(newPassword, salt);
        const again = async value => value ? this._aes.encrypt(await this._aes.decrypt(value, currentKey), newKey) : value;

        // Encrypt everything first — the database write itself must not await WebCrypto
        const rooms = [];
        for (const room of await this._db.getRooms()) {
            rooms.push({id: room.id, name: await again(room.name), base: await again(room.base)});
        }
        const epochs = [];
        for (const e of await this._db.getAllEpochs()) {
            epochs.push({roomId: e.roomId, epoch: e.epoch, secret: await again(e.secret), roster: await again(e.roster)});
        }
        const systemMessages = [];
        for (const m of await this._db.getSystemMessages()) {
            systemMessages.push({id: m.id, content: await again(m.content)});
        }
        const verify = await this._aes.encrypt(profile.uid, newKey);

        await this._db.replaceMasterKeyData({salt, verify}, rooms, epochs, systemMessages);

        this._masterKey = newKey;
        return true;
    }

    getMasterKey() {
        return this._masterKey;
    }

    // Text encrypted with the master key, e.g. the room name or a system message
    sealLocal(text) {
        return this._aes.encrypt(text, this._masterKey);
    }

    openLocal(cipher) {
        return this._aes.decrypt(cipher, this._masterKey);
    }

    // -------------------------------------------------------------------------
    // Room base: {G, inviterId, identity, invites: [{s, created}]}
    // -------------------------------------------------------------------------

    async getBase(roomId) {
        if (this._bases.has(roomId)) return this._bases.get(roomId);

        const room = await this._db.getRoom(roomId);
        if (!room?.base) return null;

        const base = JSON.parse(await this.openLocal(room.base));
        this._bases.set(roomId, base);
        return base;
    }

    // The encrypted base for the database (the caller stores it, e.g. together with a new room)
    async sealBase(roomId, base) {
        this._bases.set(roomId, base);
        return this.sealLocal(JSON.stringify(base));
    }

    // Drops the decrypted secrets of a deleted room from memory
    forgetRoom(roomId) {
        this._bases.delete(roomId);
        for (const id of [...this._epochs.keys()]) {
            if (id.startsWith(roomId + ":")) this._epochs.delete(id);
        }
    }

    async setBase(roomId, base) {
        await this._db.updateRoomFields(roomId, {base: await this.sealBase(roomId, base)});
    }

    // -------------------------------------------------------------------------
    // Epochs: {epoch, K, J, headerHash, roster, created, meta} + derived keys
    // meta: {reason, signerId, subject, prevHash} of the rotation that started the epoch (key
    // history) — sealed together with K and J, deleted with them
    // -------------------------------------------------------------------------

    // Keys of an epoch of the room, or null if this device does not have them
    async getEpoch(roomId, epoch) {
        const id = `${roomId}:${epoch}`;
        if (this._epochs.has(id)) return this._epochs.get(id);

        const row = await this._db.getEpoch(roomId, epoch);
        if (!row) return null;

        const secret = JSON.parse(await this.openLocal(row.secret));
        return this._cacheEpoch(roomId, {
            epoch, K: secret.K, J: secret.J, meta: secret.meta ?? null, headerHash: row.headerHash, created: row.created,
            roster: JSON.parse(await this.openLocal(row.roster)),
        });
    }

    async putEpoch(roomId, e) {
        await this._db.putEpoch({
            roomId, epoch: e.epoch, headerHash: e.headerHash, created: e.created,
            secret: await this.sealLocal(JSON.stringify({K: e.K, J: e.J, meta: e.meta ?? null})),
            roster: await this.sealLocal(JSON.stringify(e.roster)),
        });
        return this._cacheEpoch(roomId, e);
    }

    async _cacheEpoch(roomId, e) {
        const base = await this.getBase(roomId);
        const full = {...e, keys: await epochKeys(roomId, e.epoch, e.K, base.G), joinKey: await importJoinSecret(e.J)};
        this._epochs.set(`${roomId}:${e.epoch}`, full);
        return full;
    }

    // -------------------------------------------------------------------------
    // Join codes
    // -------------------------------------------------------------------------

    // Entry of the room for join_rooms: a member sends its epoch and a new member code (valid
    // once), a waiting new member only its epoch; since: missed messages from then on (server
    // time). Returns null for removed rooms.
    async joinEntry(room, clientId) {
        const entry = {id: room.id, epoch: room.epoch, notification: room.pushNotifications, ttl: room.ttl, store: room.store,
            since: room.syncedUntil};
        if (room.isRemoved()) return null;
        if (room.isPending() || room.epoch === 0) return entry; // waiting / creator before its first rotation

        const e = await this.getEpoch(room.id, room.epoch);
        if (!e) return entry;
        return {...entry, memberCode: await memberCode(e.joinKey, joinWindow(), clientId)};
    }

    // New invite code of the current epoch: {code, expires} — null if the room has no epoch yet
    async inviteCode(room) {
        const e = room.epoch > 0 ? await this.getEpoch(room.id, room.epoch) : null;
        if (!e) return null;

        const window = joinWindow();
        return {code: await inviteCode(e.joinKey, window), expires: joinWindowEnd(window)};
    }
}
