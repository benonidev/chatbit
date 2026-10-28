// adapters/DatabaseAdapter.js
// Responsible for: IndexedDB access and alias/key management
//
// Receives AESAdapter as a constructor argument (= Dependency Injection)
// DatabaseAdapter does not care HOW encryption works, only THAT it works

import {Events} from "./event.js";
import {Profile} from "../domain/profile.js";
import {Room} from "../domain/room.js";
import {Message} from "../domain/message.js";
import {logger} from "./log.js";

const log = logger("db");

// IndexedDB storage (via Dexie) for profile, rooms, epochs, messages and files.
// Messages and files received over the WebSocket are stored automatically.
export class DatabaseAdapter {

    constructor(aes, events) {
        this._events = events;
        this._synced = new Set(); // rooms whose missed messages of the current join are all here
    }

    async init() {
        this.db = new Dexie('ChatBit_DB');

        this.db.version(1).stores({
            profile: '&id, &uid, name',
            message: '&id, roomId, timestamp',
            room: '&id',
            file: '&id, roomId, timestamp',
        });

        // v2: rooms remember lastRead for the unread badges. Existing rooms start as read,
        // otherwise every old message would show up as unread.
        this.db.version(2).stores({}).upgrade(tx =>
            tx.table('room').toCollection().modify(room => {
                room.lastRead = Date.now();
            })
        );

        // v3: room keys with epochs (docs/room-keys.md). Rooms of the old format (one static
        // room key) can not be used anymore and are deleted with their messages and files.
        // epoch: {roomId, epoch, secret, roster, headerHash, created} — secret and roster are
        // encrypted with the master key.
        this.db.version(3).stores({
            epoch: '&[roomId+epoch], roomId',
        }).upgrade(async tx => {
            await tx.table('room').clear();
            await tx.table('message').clear();
            await tx.table('file').clear();
        });

        // v4: per room cursor of the missed messages (Room.syncedUntil, server time). Existing
        // rooms start at their newest message from the server — local system messages and clean
        // markers have client time and are left out.
        this.db.version(4).stores({}).upgrade(async tx => {
            const newest = new Map();
            await tx.table('message').each(m => {
                if (m.aliasId === undefined || m.type === Message.TYPE_SYSTEM || !m.synced) return;
                if (!(newest.get(m.roomId) >= m.timestamp)) newest.set(m.roomId, m.timestamp);
            });
            await tx.table('room').toCollection().modify(room => {
                room.syncedUntil = newest.get(room.id) ?? 0;
            });
        });

        // Cursor of the missed messages per room (Room.syncedUntil). While a join is on its way,
        // live messages may come before the missed ones: the cursor only moves with room_synced
        // then, afterwards with every message of the room.
        this._events.on(Events.WS.JOINING, (roomIds) => {
            for (const id of roomIds) this._synced.delete(id);
        });
        this._events.on(Events.WS.ROOM_SYNCED, async ({id, until}) => {
            await this._moveCursor(id, until);
            this._synced.add(id);
        });

        // subscribe to new messages
        this._events.on(Events.WS.RECEIVED_MESSAGE, async (msg) => {
            // Messages of a room that was left meanwhile (e.g. the echo of the leave message)
            if (!await this.db.room.get(msg.roomId)) return;
            // Also a message that is dropped below: it was received, no need to get it again
            if (this._synced.has(msg.roomId)) await this._moveCursor(msg.roomId, msg.timestamp);
            // A message whose signature does not match its sender is not stored (RoomKeys)
            if (this._acceptMessage && !await this._acceptMessage(msg)) return;
            await this.addMessage(msg);
            this._events.emit(Events.CHAT.MESSAGE_STORED, msg);
        });

        // The server is the authority for the room TTL and store setting (set once when the room
        // was created). Rooms created before the store setting was kept have none (undefined).
        this._events.on(Events.WS.ROOM_INFO, async (info) => {
            const changes = {ttl: info.ttl};
            if (info.store !== undefined) changes.store = info.store;
            await this.db.room.update(info.id, changes);
        });

        // Another member cleaned the room. Only messages up to the clean are deleted: newer ones
        // (sent right after the clean, also with the same join) arrive in the meantime.
        this._events.on(Events.WS.ROOM_CLEANED, async (info) => {
            await this.cleanRoom(info.id, info.timestamp);
            this._events.emit(Events.CHAT.ROOM_CLEANED, info.id);
        });

        this._events.on(Events.WS.RECEIVED_FILE, async (msg) => {
            log.debug("file received", msg.id);
            await this.addFile(msg);
        });
    }

    async isInitialized() {
        const profile = await this.db.profile.get({id: 0});
        return profile !== undefined;
    }

    async addProfile(profile) {
        await this.db.profile.add(profile.toDB());
    }

    async updateProfileName(name) {
        await this.db.profile.update(0, {name});
    }

    // Password change: new salt/verify and everything that is encrypted with the master key (room
    // names and secrets, epoch secrets and rosters, system messages) in one transaction
    async replaceMasterKeyData(profile, rooms, epochs, systemMessages) {
        await this.db.transaction("rw", this.db.profile, this.db.room, this.db.epoch, this.db.message, async () => {
            await this.db.profile.update(0, {salt: profile.salt, verify: profile.verify});
            for (const room of rooms) {
                await this.db.room.update(room.id, {name: room.name, base: room.base});
            }
            for (const e of epochs) {
                await this.db.epoch.update([e.roomId, e.epoch], {secret: e.secret, roster: e.roster});
            }
            for (const m of systemMessages) {
                await this.db.message.update(m.id, {content: m.content});
            }
        });
    }

    // Changes single fields of a room (status, epoch, base, settings) — keeps all others
    async updateRoomFields(roomId, changes) {
        await this.db.room.update(roomId, changes);
    }

    // --- Epochs ---

    async putEpoch(record) {
        await this.db.epoch.put(record);
    }

    async getEpoch(roomId, epoch) {
        return await this.db.epoch.get([roomId, epoch]);
    }

    async getAllEpochs() {
        return await this.db.epoch.toArray();
    }

    // Messages per epoch of a room on this device: Map(epoch → count) — key history
    async countMessagesByEpoch(roomId) {
        const counts = new Map();
        await this.db.message.where('roomId').equals(roomId).each(m => {
            if (m.aliasId === undefined || m.type === Message.TYPE_SYSTEM) return;
            counts.set(m.epoch, (counts.get(m.epoch) ?? 0) + 1);
        });
        return counts;
    }

    async deleteEpoch(roomId, epoch) {
        await this.db.epoch.delete([roomId, epoch]);
    }

    async getSystemMessages() {
        return await this.db.message.filter(m => m.type === Message.TYPE_SYSTEM).toArray();
    }

    // Local storage used by ChatBit: number of messages, number and size of stored images
    async storageStats() {
        let fileBytes = 0;
        await this.db.file.each(f => { fileBytes += f.blob?.byteLength ?? 0; });

        return {
            messages: await this.db.message.count(),
            rooms: await this.db.room.count(),
            files: await this.db.file.count(),
            fileBytes,
        };
    }

    // Deletes all stored images. Images of rooms with "store" can be downloaded again
    // from the server while their message lives. Returns the number of deleted images.
    async deleteFiles() {
        const count = await this.db.file.count();
        await this.db.file.clear();
        return count;
    }

    async getProfile() {
        const profile = await this.db.profile.get({id: 0})
        return Profile.fromDB(profile);
    }

    async addFile(fileM) {
        // put: a file that is downloaded again (e.g. a second click) must not fail on the existing id
        await this.db.file.put(fileM);
    }

    async getMessage(id) {
        return await this.db.message.get(id);
    }

    async getFile(fileId) {
        return await this.db.file.get(fileId);
    }

    // A message delivered twice (reconnect, server echo of an own message) only updates status,
    // timestamp and TTL. A different message with an existing id is ignored — otherwise another
    // member could replace a message by sending one with the same id.
    async addMessage(msg) {
        if (msg instanceof Message && msg.isExpired()) return; // arrived too late, don't keep it

        await this.db.transaction("rw", this.db.message, async () => {
            const existing = await this.db.message.get(msg.id);
            if (existing && !sameMessage(existing, msg)) {
                log.warn("message id exists with other content, ignored:", msg.id);
                return;
            }
            await this.db.message.put(msg);
        });
    }

    // An own message that is sent again in a new epoch (same id, new encryption)
    async replaceMessage(msg) {
        await this.db.message.put(msg);
    }

    // Deletes all expired messages and their image files. Returns the deleted [{id, roomId}].
    async purgeExpired(now = Date.now()) {
        const expired = await this.db.message
            .filter(row => Message.fromDB(row).isExpired(now))
            .toArray();
        if (expired.length === 0) return [];

        const ids = expired.map(m => m.id);
        await this.db.transaction("rw", this.db.message, this.db.file, async () => {
            await this.db.message.bulkDelete(ids);
            await this.db.file.bulkDelete(ids); // an image file has the id of its message
        });

        return expired.map(m => ({id: m.id, roomId: m.roomId}));
    }

    async getLatestMessages(roomId) {
        const messages = await this.db.message.where({roomId: roomId}).limit(100).sortBy('timestamp');

        let messagesArray = [];

        messages.forEach(room => {
            messagesArray.push(Message.fromDB(room));
        })

        return messagesArray;
    }

    // Deletes the room with everything of it on this device: epoch keys, messages and files
    async removeRoom(roomId) {
        await this.db.transaction("rw", this.db.room, this.db.epoch, this.db.message, this.db.file, async () => {
            await this.db.room.where('id').equals(roomId).delete();
            await this.db.epoch.where('roomId').equals(roomId).delete();
            const ids = await this.db.message.where('roomId').equals(roomId).primaryKeys();
            await this.db.message.bulkDelete(ids);
            await this.db.file.where('roomId').equals(roomId).delete();
        });
    }

    // Marks all messages up to timestamp (ms) as read. Only moves forward.
    async markRoomRead(roomId, timestamp) {
        await this.db.room.where({id: roomId}).modify(room => {
            if (!(room.lastRead >= timestamp)) room.lastRead = timestamp;
        });
    }

    // Number of messages newer than lastRead (own messages are marked read when they are sent)
    async countUnread(roomId, lastRead, now = Date.now()) {
        return await this.db.message
            .where('roomId').equals(roomId)
            .filter(row => row.timestamp > lastRead && row.aliasId !== undefined
                && row.type !== Message.TYPE_LEAVE && row.type !== Message.TYPE_CLEAN && !Message.fromDB(row).isExpired(now))
            .count();
    }

    // Moves the cursor of the room forward (never back)
    async _moveCursor(roomId, timestamp) {
        if (!timestamp) return;
        await this.db.room.where({id: roomId}).modify(room => {
            if (!(room.syncedUntil >= timestamp)) room.syncedUntil = timestamp;
        });
    }

    async addRoom(room) {
        await this.db.room.add(room.toJSON ? room.toJSON() : room);
    }

    // Check for received messages before they are stored: fn(msg) → false drops the message
    setMessageFilter(fn) {
        this._acceptMessage = fn;
    }

    // A message and its file
    async deleteMessage(id) {
        await this.db.transaction("rw", this.db.message, this.db.file, async () => {
            await this.db.message.delete(id);
            await this.db.file.delete(id);
        });
    }

    // Deletes the messages and files of the room up to `until` (default: all).
    async cleanRoom(roomId, until = Date.now()) {
        const ids = await this.db.message.where('roomId').equals(roomId)
            .filter(m => m.timestamp <= until)
            .primaryKeys();

        await this.db.transaction("rw", this.db.message, this.db.file, async () => {
            await this.db.message.bulkDelete(ids);
            await this.db.file.bulkDelete(ids); // a file has the id of its message
        });

        await this.addMessage(new Message({
            id: crypto.randomUUID(),
            roomId: roomId,
            timestamp: until,
        }));
    }

    // The room, or null if it does not exist (anymore)
    async getRoom(roomId) {
        const roomDB = await this.db.room.where({id: roomId}).first();

        return roomDB ? Room.fromDB(roomDB) : null;
    }

    async getRooms() {
        const rooms = await this.db.room.toArray();

        let roomsArray = [];

        rooms.forEach(room => {
            roomsArray.push(Room.fromDB(room));
        })

        return roomsArray;
    }

    // --- Cleanup ---

    async clear() {
        await this.db.profile.clear();
        await this.db.message.clear();
        await this.db.room.clear();
        await this.db.epoch.clear();
        await this.db.file.clear();
    }
}

// Same sender, type, epoch and content (all encrypted with the room key of the epoch, so they
// can't be faked without changing the ciphertext)
function sameMessage(a, b) {
    return a.roomId === b.roomId && a.type === b.type && a.content === b.content
        && a.alias === b.alias && a.aliasId === b.aliasId && a.epoch === b.epoch && a.sig === b.sig
        && a.reply === b.reply;
}
