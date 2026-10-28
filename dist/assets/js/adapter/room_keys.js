import {Events} from "./event.js";
import {Notifications} from "./notification.js";
import {Room} from "../domain/room.js";
import {Message} from "../domain/message.js";
import {
    buildJoinRequest, buildKeyUpdate, buildRotation, fingerprint, newExchangeKey, newIdentity, newRoomSecret,
    openJoinRequest, openKeyUpdate, openRotation, rosterEntry, signAlias, signMessage, verifyMessage, b64, MAX_ALIAS,
} from "./room_crypto.js";
import {logger} from "./log.js";

const log = logger("rooms");

const DAY = 24 * 60 * 60 * 1000;
const ROTATE_EVERY = DAY;             // periodic rotation (docs/room-keys.md Q2)
const RENEW_KEY_EVERY = 30 * DAY;     // X25519 key renewal (Q7)
const INVITE_LIFETIME = DAY + 60 * 60 * 1000; // invite secrets are kept a bit longer than a join request waits
const RESEND_ATTEMPTS = 3;

// The room key protocol of docs/room-keys.md on the client: creating rooms, joining with an
// invite, applying rotations and doing own ones (add, leave, remove, periodic), catching up after
// being offline, approving join requests, renewing the exchange key, and encrypting / checking
// messages with the keys of their epoch.
//
// All work on one room runs in order (one queue per room): rotations must be applied one by one.
export class RoomKeys {
    // options.delay(max): random delay in ms before own rotations (tests use 0)
    constructor(events, db, keyStore, aes, options = {}) {
        this._events = events;
        this._db = db;
        this._keyStore = keyStore;
        this._aes = aes;
        this._delay = options.delay ?? randomDelay;

        this._queues = new Map();      // roomId → promise of the last queued job
        this._joining = new Map();     // roomId → epoch of the join that is on its way
        this._ready = new Map();       // roomId → epoch the server accepted our join for
        this._readyWaiters = new Map();// roomId → [resolve]
        this._building = new Map();    // roomId → epoch of our rotation that is on its way
        this._intents = new Map();     // roomId → [{reason, subject, entry?}] changes for the next own rotation
        this._intentTimers = new Map();
        this._keyUpdates = new Map();  // roomId → Map(memberId → {x, xDate, epoch})
        this._asked = new Set();       // join requests already shown ("roomId:memberId")
        this._resent = new Map();      // message id → attempts
        this._outOfSync = new Set();   // rooms whose rotation could not be verified (warned once)
    }

    init() {
        const on = (event, fn) => this._events.on(event, data => fn(data).catch(err => log.error(event, "failed:", err)));

        on(Events.WS.ROTATION, async rot => this._queue(rot.roomId, () => this._applyRotations(rot.roomId, [rot])));

        on(Events.WS.JOIN_REJECTED, async rej => {
            this._joining.delete(rej.id);
            if (rej.reason === "rotated") {
                await this._queue(rej.id, () => this._applyRotations(rej.id, rej.rotations ?? [], true));
            }
        });

        on(Events.WS.ROOM_INFO, async info => this._queue(info.id, () => this._joined(info)));

        on(Events.WS.REJOIN_REQUIRED, async ({roomId}) => {
            this._ready.delete(roomId);
            this._joining.delete(roomId);
            // Queued: the rotation came first and is applied before
            await this._queue(roomId, () => this._rejoin(roomId));
        });

        on(Events.WS.ROTATE_REJECTED, async ({roomId, current}) => {
            this._building.delete(roomId);
            await this._queue(roomId, async () => {
                const room = await this._db.getRoom(roomId);
                // Another rotation was first — it arrives as rotation, or we catch up with a join
                if (room && current > room.epoch) await this._rejoin(roomId);
            });
        });

        on(Events.WS.JOIN_REQUEST, async req => this._queue(req.roomId, () => this._onJoinRequest(req)));
        on(Events.WS.KEY_UPDATE, async u => this._queue(u.roomId, () => this._onKeyUpdate(u)));
        on(Events.WS.MESSAGE_REJECTED, async m => this._resend(m));
        on(Events.WS.RECEIVED_MESSAGE, async msg => {
            if (msg.type === Message.TYPE_LEAVE) await this._onLeaveMessage(msg);
        });
        // The answer deletes the request on the server — it does not come again after the next login
        on(Events.ROOM.APPROVE, async ({roomId, entry, request}) => {
            if (request) this._events.emit(Events.WS.SEND_ANSWER_REQUEST, {roomId, request, approved: true});
            await this._addIntent(roomId, {reason: "add", subject: entry.memberId, entry}, 0);
        });
        on(Events.ROOM.DECLINE, async ({roomId, request}) => {
            this._events.emit(Events.WS.SEND_ANSWER_REQUEST, {roomId, request, approved: false});
        });
        // A new connection: joins and own rotations of the old one got no answer
        on(Events.WS.CONNECTED, async () => {
            this._joining.clear();
            this._building.clear();
        });
    }

    // Runs fn after everything queued for the room before
    _queue(roomId, fn) {
        const next = (this._queues.get(roomId) ?? Promise.resolve()).then(fn).catch(err => log.error("room job failed:", err));
        this._queues.set(roomId, next);
        return next;
    }

    // -------------------------------------------------------------------------
    // Create and join
    // -------------------------------------------------------------------------

    // New room: this device is its only member, epoch 1 is the first rotation. Returns the room id.
    async createRoom({name, pushNotifications, store, ttl}) {
        const id = crypto.randomUUID();
        const identity = await newIdentity();
        const base = {G: newRoomSecret(), inviterId: null, identity, invites: [], alias: await this._profileAlias()};

        await this._db.addRoom(new Room({
            id, name: await this._keyStore.sealLocal(name), base: await this._keyStore.sealBase(id, base),
            status: Room.STATUS_MEMBER, epoch: 0, pushNotifications, store, ttl,
        }));

        // The join creates the room on the server (TTL and store are only taken then)
        this._events.emit(Events.WS.JOIN_ROOM, {id, epoch: 0, notification: pushNotifications, ttl, store});
        await this._queue(id, () => this._sendRotation(id, [{reason: "create"}]));

        return id;
    }

    // Join with an invite ({i, n, g, s, m, c}): the room waits for the approval of the inviter.
    // Returns false if the room exists on this device already.
    async joinByInvite(invite) {
        const identity = await newIdentity();
        const base = {G: invite.g, inviterId: invite.m, identity, invites: [], alias: await this._profileAlias()};

        try {
            await this._db.addRoom(new Room({
                id: invite.i, name: await this._keyStore.sealLocal(invite.n), base: await this._keyStore.sealBase(invite.i, base),
                status: Room.STATUS_PENDING, epoch: 0, pushNotifications: true, store: true, ttl: 0,
            }));
        } catch (err) {
            if (err.name === "ConstraintError") return false;
            throw err;
        }

        const request = await buildJoinRequest({roomId: invite.i, G: invite.g, s: invite.s, identity, alias: base.alias, inviterId: invite.m});
        this._events.emit(Events.WS.SEND_JOIN_REQUEST, {roomId: invite.i, inviteCode: invite.c, request});
        return true;
    }

    // The alias of the profile is only the suggestion for new rooms: in a room it is fixed when the
    // room is created or joined (signed by the member, in the roster) and can not be changed
    async _profileAlias() {
        return String((await this._db.getProfile())?.name ?? "").trim().slice(0, MAX_ALIAS);
    }

    // Leaves the room: a signed leave message tells the others to rotate without this device
    async leave(roomId) {
        const room = await this._db.getRoom(roomId);
        if (room?.isMember() && this._ready.get(roomId) === room.epoch) {
            const msg = await this.encryptMessage(roomId, {type: Message.TYPE_LEAVE, content: ""});
            if (msg) this._events.emit(Events.WS.SEND_MESSAGE, msg);
        }

        this._events.emit(Events.WS.LEAVE_ROOM, roomId);
        await this.deleteLocal(roomId);
    }

    // Deletes the room on this device: base key, identity, all epoch keys, messages and files —
    // in the database and in memory
    async deleteLocal(roomId) {
        this._forget(roomId);
        await this._db.removeRoom(roomId);
        this._keyStore.forgetRoom(roomId);
    }

    // Removes another member: the next rotation leaves it out
    async removeMember(roomId, memberId) {
        await this._addIntent(roomId, {reason: "remove", subject: memberId}, 0);
    }

    _forget(roomId) {
        for (const map of [this._joining, this._ready, this._building, this._intents, this._keyUpdates]) map.delete(roomId);
        clearTimeout(this._intentTimers.get(roomId));
    }

    // -------------------------------------------------------------------------
    // Joining the server
    // -------------------------------------------------------------------------

    // Joins the room again with a code of the newest epoch this device knows (or as waiting new
    // member). A join that is on its way for the same epoch is not sent twice.
    async _rejoin(roomId) {
        const room = await this._db.getRoom(roomId);
        if (!room || room.isRemoved()) return;
        if (this._joining.get(roomId) === room.epoch) return;

        const entry = await this._keyStore.joinEntry(room, this._keyStore.clientId);
        if (!entry) return;

        this._joining.set(roomId, room.epoch);
        this._events.emit(Events.WS.JOIN_ROOM, entry);
    }

    // room_info: the server accepted the join
    async _joined(info) {
        this._joining.delete(info.id);
        const room = await this._db.getRoom(info.id);
        if (!room) return;

        if (info.pending) {
            // Waiting for the approval: remember the epoch, rotations are counted from here
            if (room.epoch < info.epoch) await this._db.updateRoomFields(room.id, {epoch: info.epoch});
            return;
        }

        if (info.epoch !== room.epoch) return; // an older answer — a newer join is on its way

        this._ready.set(room.id, room.epoch);
        for (const resolve of this._readyWaiters.get(room.id) ?? []) resolve();
        this._readyWaiters.delete(room.id);
        this._events.emit(Events.ROOM.READY, {roomId: room.id, epoch: room.epoch});

        await this._maintain(room);
    }

    // Resolves when the room is joined in its current epoch (or after timeoutMs with false)
    whenReady(roomId, timeoutMs = 30000) {
        return this._db.getRoom(roomId).then(room => {
            if (room && this._ready.get(roomId) === room.epoch) return true;
            return new Promise(resolve => {
                const timer = setTimeout(() => resolve(false), timeoutMs);
                const list = this._readyWaiters.get(roomId) ?? [];
                list.push(() => { clearTimeout(timer); resolve(true); });
                this._readyWaiters.set(roomId, list);
            });
        });
    }

    isReady(roomId, epoch) {
        return this._ready.get(roomId) === epoch;
    }

    // After a join: periodic rotation, key renewal, changes that are still to do, old epochs
    async _maintain(room) {
        const current = await this._keyStore.getEpoch(room.id, room.epoch);
        if (!current) return;

        if (this._intents.get(room.id)?.length) this._scheduleIntents(room.id, this._delay(5000));

        if (Date.now() - (current.created ?? 0) > ROTATE_EVERY) {
            // Everybody online would do it — a random delay and "first one wins" keep it to one
            await this._addIntent(room.id, {reason: "renew"}, this._delay(60000));
        } else {
            await this._renewKeyIfOld(room, current);
        }

        await this._purgeEpochs(room);
    }

    // -------------------------------------------------------------------------
    // Rotations
    // -------------------------------------------------------------------------

    // Applies rotations in order. catchUp: they came with join_rejected {rotated} — join again
    // afterwards in any case.
    async _applyRotations(roomId, rotations, catchUp = false) {
        let room = await this._db.getRoom(roomId);
        if (!room || room.isRemoved()) return;
        const base = await this._keyStore.getBase(roomId);

        let joinAgain = catchUp;
        for (const rot of [...rotations].sort((a, b) => a.epoch - b.epoch)) {
            if (rot.epoch <= room.epoch) continue; // known already

            if (room.isPending()) {
                const result = await this._applyAsPending(room, base, rot);
                if (result === "member") joinAgain = true;
                room = await this._db.getRoom(roomId);
                continue;
            }

            if (rot.epoch !== room.epoch + 1) {
                log.debug("rotation gap, catching up", roomId, room.epoch, rot.epoch);
                joinAgain = true;
                break;
            }

            const result = await this._applyAsMember(room, base, rot);
            if (result === "removed" || result === "invalid") return;
            joinAgain = true;
            room = await this._db.getRoom(roomId);
        }

        if (joinAgain) {
            this._joining.delete(roomId);
            await this._rejoin(roomId);
        }
    }

    // A waiting new member: it can only check rotations signed by its inviter. The one that has
    // an envelope for it makes it a member; others only move its epoch forward.
    async _applyAsPending(room, base, rot) {
        let opened;
        try {
            opened = await openRotation({roomId: room.id, G: base.G, body: rot.body, expectedEpoch: rot.epoch, prev: null, inviterId: base.inviterId, identity: base.identity});
        } catch (err) {
            log.debug("rotation not for this waiting member:", err.reason);
            opened = {member: false};
        }

        if (!opened.member) {
            await this._db.updateRoomFields(room.id, {epoch: rot.epoch});
            return "waiting";
        }

        await this._keyStore.putEpoch(room.id, {epoch: rot.epoch, K: opened.K, J: opened.J, headerHash: opened.headerHash, roster: opened.roster, created: opened.header.created, meta: headerMeta(opened.header)});
        await this._db.updateRoomFields(room.id, {epoch: rot.epoch, status: Room.STATUS_MEMBER});
        await this._systemMessage(room, opened.header, null, opened.roster, base.identity.memberId);
        this._events.emit(Events.ROOM.CHANGED, room.id);
        this._events.emit(Events.ROOM.ROTATED, {roomId: room.id, epoch: rot.epoch});
        return "member";
    }

    async _applyAsMember(room, base, rot) {
        // Epoch 1 of an own new room has no previous epoch
        const prev = room.epoch > 0 ? await this._keyStore.getEpoch(room.id, room.epoch) : null;
        if (room.epoch > 0 && !prev) {
            log.warn("keys of the current epoch are missing");
            return "invalid";
        }

        let opened;
        try {
            opened = await openRotation({
                roomId: room.id, G: base.G, body: rot.body, expectedEpoch: rot.epoch,
                prev: prev ? {headerHash: prev.headerHash, roster: prev.roster} : null, identity: base.identity,
            });
        } catch (err) {
            log.warn("rotation rejected:", err.reason ?? err.message);
            this._warnOutOfSync(room);
            return "invalid";
        }

        if (this._building.get(room.id) === rot.epoch) this._building.delete(room.id);

        if (!opened.member) {
            // Not in the new member list: removed (or left on another device)
            await this._db.updateRoomFields(room.id, {epoch: rot.epoch, status: Room.STATUS_REMOVED});
            await this._systemMessage(room, opened.header, prev?.roster, null, base.identity.memberId);
            this._events.emit(Events.WS.LEAVE_ROOM, room.id); // the server can forget this device
            this._forget(room.id);
            this._events.emit(Events.ROOM.CHANGED, room.id);
            return "removed";
        }

        await this._keyStore.putEpoch(room.id, {epoch: rot.epoch, K: opened.K, J: opened.J, headerHash: opened.headerHash, roster: opened.roster, created: opened.header.created, meta: headerMeta(opened.header)});
        await this._db.updateRoomFields(room.id, {epoch: rot.epoch});

        // The previous exchange key is not needed anymore once a rotation used the new one
        const own = opened.roster.find(m => m.memberId === base.identity.memberId);
        if (base.identity.xSeedPrevious && own?.x === base.identity.x) {
            delete base.identity.xSeedPrevious;
            await this._keyStore.setBase(room.id, base);
        }

        this._keyUpdates.delete(room.id); // they belonged to the old epoch
        this._dropDoneIntents(room.id, opened.roster);
        await this._systemMessage(room, opened.header, prev?.roster, opened.roster, base.identity.memberId);
        this._events.emit(Events.ROOM.ROTATED, {roomId: room.id, epoch: rot.epoch});
        return "member";
    }

    _warnOutOfSync(room) {
        if (this._outOfSync.has(room.id)) return;
        this._outOfSync.add(room.id);
        this._events.emit(Notifications.DANGER, {
            header: "Member list could not be verified",
            msg: "A key change of a room was not signed by a member. Messages of that room can not be read until it is fixed — ask for a new invite if it stays.",
            time: 10000,
        });
    }

    // Changes for the next own rotation. Several changes that come in at once go into one rotation.
    async _addIntent(roomId, intent, delay) {
        const list = this._intents.get(roomId) ?? [];
        if (!list.some(i => i.reason === intent.reason && i.subject === intent.subject)) list.push(intent);
        this._intents.set(roomId, list);
        this._scheduleIntents(roomId, delay);
    }

    _scheduleIntents(roomId, delay) {
        clearTimeout(this._intentTimers.get(roomId));
        this._intentTimers.set(roomId, setTimeout(() => {
            this._queue(roomId, async () => {
                const intents = this._intents.get(roomId) ?? [];
                if (intents.length === 0) return;
                if (this._building.has(roomId)) return; // the answer to the last one is still on its way
                await this._sendRotation(roomId, intents);
            });
        }, delay));
    }

    // Intents that the newest roster fulfils are done; "renew" is done by any rotation
    _dropDoneIntents(roomId, roster) {
        const has = id => roster.some(m => m.memberId === id);
        const open = (this._intents.get(roomId) ?? []).filter(i =>
            (i.reason === "add" && !has(i.subject)) || ((i.reason === "remove" || i.reason === "leave") && has(i.subject)));
        if (open.length) this._intents.set(roomId, open);
        else this._intents.delete(roomId);
    }

    // Builds and sends the rotation to the next epoch with all intents. The result arrives as
    // rotation (applied like any other) or rotate_rejected (the intents stay and are tried again).
    async _sendRotation(roomId, intents) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember()) return;
        if (room.epoch > 0 && this._ready.get(roomId) !== room.epoch) return; // after the next join (_maintain)

        const base = await this._keyStore.getBase(roomId);
        const current = room.epoch > 0 ? await this._keyStore.getEpoch(roomId, room.epoch) : null;
        if (room.epoch > 0 && !current) return;

        let roster = (current?.roster ?? []).map(m => ({...m}));

        // New exchange keys of the others
        for (const [memberId, u] of this._keyUpdates.get(roomId) ?? []) {
            const m = roster.find(r => r.memberId === memberId);
            if (m && u.epoch === room.epoch && u.xDate > (m.xDate ?? 0)) Object.assign(m, {x: u.x, xDate: u.xDate});
        }

        // Every own rotation renews the own exchange key — unless the current one was never
        // announced (an earlier own rotation was rejected): then that one is used
        const ownEntry = roster.find(m => m.memberId === base.identity.memberId);
        if (!ownEntry || ownEntry.x === base.identity.x) {
            base.identity = {...base.identity, xSeedPrevious: ownEntry ? base.identity.xSeed : undefined, ...await newExchangeKey()};
            await this._keyStore.setBase(roomId, base);
        }
        // The own alias stays the one of the roster (rooms from before the signed alias get the
        // signature now); the first rotation of a room takes the alias chosen when it was created
        roster = roster.filter(m => m.memberId !== base.identity.memberId);
        if (ownEntry) {
            roster.push({...ownEntry, x: base.identity.x, xDate: base.identity.xDate,
                aliasSig: ownEntry.aliasSig ?? signAlias(roomId, base.identity, ownEntry.alias ?? "")});
        } else {
            roster.push(rosterEntry(roomId, base.identity, base.alias ?? await this._profileAlias()));
        }

        let changed = room.epoch === 0;
        for (const i of intents) {
            if (i.reason === "add" && !roster.some(m => m.memberId === i.subject)) {
                roster.push(i.entry);
                changed = true;
            }
            if ((i.reason === "remove" || i.reason === "leave") && roster.some(m => m.memberId === i.subject)) {
                roster = roster.filter(m => m.memberId !== i.subject);
                changed = true;
            }
            if (i.reason === "renew" || i.reason === "create") changed = true;
        }
        if (!changed) {
            this._intents.delete(roomId);
            return;
        }

        const first = intents.find(i => i.reason !== "renew") ?? intents[0];
        const epoch = room.epoch + 1;
        const rot = await buildRotation({
            roomId, G: base.G, epoch, prevHash: current?.headerHash ?? null, identity: base.identity,
            roster, reason: first.reason, subject: first.subject,
        });

        this._building.set(roomId, epoch);
        this._intents.set(roomId, intents.filter(i => i.reason !== "renew" && i.reason !== "create"));
        this._events.emit(Events.WS.SEND_ROTATE, {roomId, epoch, joinSecret: rot.joinSecret, body: rot.body});
    }

    // -------------------------------------------------------------------------
    // Join requests, key updates, leave messages
    // -------------------------------------------------------------------------

    // Only the inviter can check a request: it knows the invite secret s of its QR code
    async _onJoinRequest({roomId, request}) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember()) return;

        const base = await this._keyStore.getBase(roomId);
        const invites = (base.invites ?? []).filter(i => Date.now() - i.created < INVITE_LIFETIME);

        let opened = null;
        for (const invite of invites) {
            try {
                const o = await openJoinRequest({roomId, G: base.G, request, s: invite.s});
                if (o.macOk) {
                    opened = o;
                    break;
                }
            } catch (err) {
                log.debug("invalid join request:", err.reason);
                return;
            }
        }
        if (!opened || opened.inviterId !== base.identity.memberId) return; // not our invite

        const current = await this._keyStore.getEpoch(roomId, room.epoch);
        if (current?.roster.some(m => m.memberId === opened.entry.memberId)) return; // approved already

        const key = `${roomId}:${opened.entry.memberId}`;
        if (this._asked.has(key)) return;
        this._asked.add(key);

        this._events.emit(Events.ROOM.JOIN_REQUEST, {
            roomId, roomName: await this._keyStore.openLocal(room.name), entry: opened.entry,
            fingerprint: fingerprint(opened.entry.memberId), request,
        });
    }

    async _onKeyUpdate({roomId, epoch, update}) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember() || epoch !== room.epoch) return;

        const current = await this._keyStore.getEpoch(roomId, room.epoch);
        if (!current) return;

        try {
            const u = await openKeyUpdate({roomId, epoch, keys: current.keys, update, roster: current.roster});
            const updates = this._keyUpdates.get(roomId) ?? new Map();
            updates.set(u.memberId, {...u, epoch});
            this._keyUpdates.set(roomId, updates);
        } catch (err) {
            log.warn("key update rejected:", err.reason);
        }
    }

    // Renews the own exchange key if it is old and announces it with a key update
    async _renewKeyIfOld(room, current) {
        const base = await this._keyStore.getBase(room.id);
        if (Date.now() - (base.identity.xDate ?? 0) < RENEW_KEY_EVERY) return;
        const own = current.roster.find(m => m.memberId === base.identity.memberId);
        if (own?.x !== base.identity.x) return; // a new key is announced already

        base.identity = {...base.identity, xSeedPrevious: base.identity.xSeed, ...await newExchangeKey()};
        await this._keyStore.setBase(room.id, base);
        const update = await buildKeyUpdate({roomId: room.id, epoch: room.epoch, keys: current.keys, identity: base.identity});
        this._events.emit(Events.WS.SEND_KEY_UPDATE, {roomId: room.id, epoch: room.epoch, update});
    }

    // A member left: rotate without it (whoever is first)
    async _onLeaveMessage(msg) {
        const opened = await this.decryptMessage(msg);
        if (!opened?.verified || opened.own) return;
        await this._addIntent(msg.roomId, {reason: "leave", subject: opened.senderId}, this._delay(5000));
    }

    // -------------------------------------------------------------------------
    // Invites
    // -------------------------------------------------------------------------

    // Everything for a new invite code: {invite: {i, n, g, s, m, c}, expires} — null if the room
    // has no epoch yet. Every invite has its own secret s; they are kept for INVITE_LIFETIME.
    async newInvite(roomId) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember()) return null;

        const code = await this._keyStore.inviteCode(room);
        if (!code) return null;

        const base = await this._keyStore.getBase(roomId);
        const s = b64(crypto.getRandomValues(new Uint8Array(16)));
        base.invites = [...(base.invites ?? []).filter(i => Date.now() - i.created < INVITE_LIFETIME), {s, created: Date.now()}];
        await this._keyStore.setBase(roomId, base);

        return {
            invite: {i: roomId, n: await this._keyStore.openLocal(room.name), g: base.G, s, m: base.identity.memberId, c: code.code},
            expires: code.expires,
        };
    }

    // -------------------------------------------------------------------------
    // Members
    // -------------------------------------------------------------------------

    // Member list of the current epoch: [{memberId, alias, fingerprint, keyAge, own}]
    async members(roomId) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember() || room.epoch === 0) return [];

        const base = await this._keyStore.getBase(roomId);
        const current = await this._keyStore.getEpoch(roomId, room.epoch);
        const roster = current?.roster ?? [];
        return roster.map(m => ({
            memberId: m.memberId,
            alias: displayName(m, roster),
            fingerprint: fingerprint(m.memberId),
            keyAge: m.xDate ? Date.now() - m.xDate : null,
            own: m.memberId === base.identity.memberId,
        }));
    }

    // Key history: every epoch this device still has, newest first —
    // [{epoch, created, current, reason, signer, subject, added, removed, members, headerHash,
    //   prevHash, messages}]. signer / subject / members are {memberId, alias, fingerprint, own}.
    // Epochs from before the history was kept have no reason: added / removed come from comparing
    // the member list with the one before.
    async history(roomId) {
        const room = await this._db.getRoom(roomId);
        const base = await this._keyStore.getBase(roomId);
        if (!room || !base) return [];

        const numbers = (await this._db.getAllEpochs()).filter(e => e.roomId === roomId).map(e => e.epoch).sort((a, b) => a - b);
        const counts = await this._db.countMessagesByEpoch(roomId);
        const ownId = base.identity.memberId;

        const list = [];
        let prev = null;
        for (const n of numbers) {
            const e = await this._keyStore.getEpoch(roomId, n);
            if (!e) continue;
            const roster = e.roster ?? [];
            // Names also of members that are not in this roster anymore (left / removed)
            const known = roster.concat((prev?.roster ?? []).filter(p => !roster.some(m => m.memberId === p.memberId)));
            const person = id => {
                if (!id) return null;
                const m = known.find(k => k.memberId === id);
                return {memberId: id, alias: m ? displayName(m, known) : "?", fingerprint: fingerprint(id), own: id === ownId};
            };
            const ids = roster.map(m => m.memberId);
            const prevIds = prev && prev.epoch === n - 1 ? prev.roster.map(m => m.memberId) : null;

            list.push({
                epoch: n,
                created: e.created ?? null,
                current: n === room.epoch,
                reason: e.meta?.reason ?? null,
                signer: person(e.meta?.signerId),
                subject: person(e.meta?.subject),
                added: prevIds ? ids.filter(id => !prevIds.includes(id)).map(person) : [],
                removed: prevIds ? prevIds.filter(id => !ids.includes(id)).map(person) : [],
                members: roster.map(m => person(m.memberId)),
                headerHash: e.headerHash,
                prevHash: e.meta?.prevHash ?? null,
                messages: counts.get(n) ?? 0,
            });
            prev = e;
        }
        return list.reverse();
    }

    // Security status of a room: {status, epoch, since, members, fingerprint} — epoch 0 / members
    // 0 while the room has no keys yet (waiting for approval, not connected yet)
    async securityInfo(roomId) {
        const room = await this._db.getRoom(roomId);
        const base = await this._keyStore.getBase(roomId);
        if (!room || !base) return null;

        const current = room.isMember() && room.epoch > 0 ? await this._keyStore.getEpoch(roomId, room.epoch) : null;
        return {
            status: room.status,
            epoch: current ? room.epoch : 0,
            since: current?.created ?? null,
            members: current?.roster.length ?? 0,
            fingerprint: fingerprint(base.identity.memberId),
        };
    }

    async ownMemberId(roomId) {
        return (await this._keyStore.getBase(roomId))?.identity.memberId ?? null;
    }

    // -------------------------------------------------------------------------
    // Messages
    // -------------------------------------------------------------------------

    // Keys for sending: {epoch, keys} of the current epoch, or null
    async currentKeys(roomId) {
        const room = await this._db.getRoom(roomId);
        if (!room?.isMember() || room.epoch === 0) return null;
        const e = await this._keyStore.getEpoch(roomId, room.epoch);
        return e ? {epoch: room.epoch, keys: e.keys} : null;
    }

    async keysOf(roomId, epoch) {
        return (await this._keyStore.getEpoch(roomId, epoch))?.keys ?? null;
    }

    // A message of this device in the current epoch: member id, content and signature encrypted
    // with its message key — no alias, the others take it from the roster.
    // fields: {type, content, ttl, store, replyTo?, ...file fields}
    async encryptMessage(roomId, fields, id = crypto.randomUUID()) {
        const room = await this._db.getRoom(roomId);
        const current = await this.currentKeys(roomId);
        if (!current) return null;

        const base = await this._keyStore.getBase(roomId);
        const content = fields.content ?? "";
        const replyTo = fields.replyTo || undefined;
        const sig = signMessage(base.identity, {roomId, epoch: current.epoch, id, type: fields.type, content, replyTo});
        const key = current.keys.messageKey;

        return new Message({
            ...fields, id, roomId, epoch: current.epoch, store: fields.store ?? room.store,
            aliasId: await this._aes.encryptPadded(base.identity.memberId, key),
            content: content ? await this._aes.encryptPadded(content, key) : undefined,
            sig: await this._aes.encryptPadded(sig, key),
            reply: replyTo ? await this._aes.encryptPadded(replyTo, key) : undefined,
            timestamp: Date.now(),
            synced: false,
        });
    }

    // Decrypts and checks a message: {alias, senderId, content, replyTo, verified, own} —
    // null if this
    // device has no keys of its epoch (yet). verified: signed by the member of that epoch whose id
    // is in the message. alias is the name of that member in the roster of the epoch, never one
    // from the message itself.
    async decryptMessage(msg) {
        const e = await this._keyStore.getEpoch(msg.roomId, msg.epoch);
        if (!e) return null;

        const key = e.keys.messageKey;
        let legacyAlias, senderId, content, sig, replyTo;
        try {
            // Messages from before the alias moved into the roster signed the alias they carried
            legacyAlias = msg.alias ? await this._aes.decrypt(msg.alias, key) : "";
            senderId = await this._aes.decrypt(msg.aliasId, key);
            content = msg.content ? await this._aes.decrypt(msg.content, key) : "";
            sig = msg.sig ? await this._aes.decrypt(msg.sig, key) : "";
            replyTo = msg.reply ? await this._aes.decrypt(msg.reply, key) : undefined;
        } catch {
            return null;
        }

        const sender = e.roster.find(m => m.memberId === senderId);
        const verified = !!sender && verifyMessage(sender.ed, {roomId: msg.roomId, epoch: msg.epoch, id: msg.id, type: msg.type, alias: legacyAlias, content, replyTo}, sig);
        const base = await this._keyStore.getBase(msg.roomId);

        return {
            alias: sender ? displayName(sender, e.roster) : "?", senderId, content, replyTo, verified,
            own: senderId === base.identity.memberId,
        };
    }

    // false for a received message that must not be stored: its signature does not match the
    // member it claims to come from (or it can not be decrypted with the keys of its epoch).
    // Messages of an epoch this device has no keys of yet are checked when they are shown.
    async acceptMessage(msg) {
        if (!await this._keyStore.getEpoch(msg.roomId, msg.epoch)) return true;
        const plain = await this.decryptMessage(msg);
        if (plain?.verified) return true;
        log.warn("message dropped: signature not valid", msg.id);
        return false;
    }

    // The server did not take a message because the room rotated while it was on its way: it is
    // encrypted again with the new epoch and sent once more (text only — a file was uploaded with
    // the old key and has to be sent again by the user).
    async _resend({id, roomId}) {
        const attempts = (this._resent.get(id) ?? 0) + 1;
        this._resent.set(id, attempts);

        const row = await this._db.getMessage(id);
        if (!row) return;
        const msg = Message.fromDB(row);

        if (attempts > RESEND_ATTEMPTS || msg.isImage() || msg.isFile() || !(await this.whenReady(roomId))) {
            this._events.emit(Notifications.WARNING, {header: "Not sent", msg: "A message could not be sent. Please send it again."});
            return;
        }

        const plain = await this.decryptMessage(msg);
        if (!plain?.own) return;

        const again = await this.encryptMessage(roomId, {type: msg.type, content: plain.content, replyTo: plain.replyTo, ttl: msg.ttl, store: msg.store}, id);
        if (!again) return;
        await this._db.replaceMessage(again);
        this._events.emit(Events.WS.SEND_MESSAGE, again);
    }

    // "Alice added Dave" etc. in the chat — stored locally, encrypted with the master key
    async _systemMessage(room, header, prevRoster, roster, ownId) {
        const name = id => (roster ?? []).concat(prevRoster ?? []).find(m => m.memberId === id)?.alias || "someone";
        const who = id => id === ownId ? "You" : name(id);
        const whom = id => id === ownId ? "you" : name(id);

        let text = null;
        switch (header.reason) {
            case "create": text = "Room created"; break;
            case "add":    text = header.subject === ownId ? `You joined — added by ${name(header.signerId)}` : `${who(header.signerId)} added ${whom(header.subject)}`; break;
            case "leave":  text = `${name(header.subject)} left the room`; break;
            case "remove": text = `${who(header.signerId)} removed ${whom(header.subject)}`; break;
        }
        if (!roster) text = header.reason === "leave" ? "You left the room" : "You were removed from the room";
        if (!text) return;

        const msg = new Message({
            id: crypto.randomUUID(), roomId: room.id, type: Message.TYPE_SYSTEM, synced: true,
            content: await this._keyStore.sealLocal(text), timestamp: header.created ?? Date.now(), ttl: room.ttl,
        });
        await this._db.addMessage(msg);
        this._events.emit(Events.CHAT.SYSTEM_MESSAGE, msg);
    }

    // Epoch keys are kept as long as messages of that epoch can exist (room TTL), then deleted
    async _purgeEpochs(room) {
        const maxAge = (room.ttl > 0 ? Math.min(room.ttl, Message.MAX_TTL) : Message.MAX_TTL) * 1000 + DAY;
        for (const e of await this._db.getAllEpochs()) {
            if (e.roomId === room.id && e.epoch < room.epoch && (e.created ?? 0) + maxAge < Date.now()) {
                await this._db.deleteEpoch(room.id, e.epoch);
            }
        }
    }
}

// What the key history keeps of a rotation header (the rest is in the roster and the hash)
function headerMeta(header) {
    return {reason: header.reason, signerId: header.signerId, subject: header.subject ?? null, prevHash: header.prevHash};
}

// Name of a member as shown in the chat: its alias from the roster, with the start of the
// fingerprint when another member of the roster has the same alias (no two "Bob"s that look alike)
function displayName(member, roster) {
    const norm = a => String(a ?? "").trim().toLowerCase();
    const alias = member.alias?.trim() || "?";
    const same = roster.filter(m => norm(m.alias) === norm(member.alias)).length;
    return same > 1 ? `${alias} · ${member.memberId.slice(0, 4).toUpperCase()}` : alias;
}

function randomDelay(max) {
    return Math.floor(Math.random() * max);
}
