// adapters/DatabaseAdapter.js
// Responsible for: IndexedDB access and alias/key management
//
// Receives AESAdapter as a constructor argument (= Dependency Injection)
// DatabaseAdapter does not care HOW encryption works, only THAT it works

import {Events} from "./event.js";
import {Profile} from "../domain/profile.js";
import {Room} from "../domain/room.js";
import {Message} from "../domain/message.js";

// IndexedDB storage (via Dexie) for profile, rooms, messages and files.
// Messages and files received over the WebSocket are stored automatically.
export class DatabaseAdapter {

    constructor(aes, events) {
        this._events = events;
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

        // subscribe to new messages
        this._events.on(Events.WS.RECEIVED_MESSAGE, async (msg) => {
            console.log("Received message:", msg.type);
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
            console.log("Received file:", msg.id);
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

    // Password change: new salt/verify and the re-encrypted room names, keys and join secrets in one transaction
    async replaceMasterKeyData(profile, rooms) {
        await this.db.transaction("rw", this.db.profile, this.db.room, async () => {
            await this.db.profile.update(0, {salt: profile.salt, verify: profile.verify});
            for (const room of rooms) {
                await this.db.room.update(room.id, {name: room.name, key: room.key, joinSecret: room.joinSecret});
            }
        });
    }

    // Join secret of the room, encrypted with the master key
    async updateJoinSecret(roomId, joinSecret) {
        await this.db.room.update(roomId, {joinSecret});
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
                console.warn("Message id exists with other content, ignored:", msg.id);
                return;
            }
            await this.db.message.put(msg);
        });
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

    async getLatestTimestamp() {
        const messages = await this.db.message.orderBy('timestamp').last();

        return messages ? messages.timestamp : Date.now();
    }

    async getLatestMessages(roomId) {
        const messages = await this.db.message.where({roomId: roomId}).limit(100).sortBy('timestamp');

        let messagesArray = [];

        messages.forEach(room => {
            console.log(room);
            messagesArray.push(Message.fromDB(room));
        })

        return messagesArray;
    }

    async removeRoom(roomId) {
        await this.db.room.where('id').equals(roomId).delete();
    }

    // Keeps lastRead: the room objects built from the edit modal don't know it
    async updateRoom(room) {
        await this.db.transaction("rw", this.db.room, async () => {
            const old = await this.db.room.get(room.id);
            await this.db.room.put({...room, lastRead: old?.lastRead ?? room.lastRead});
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
            .filter(row => row.timestamp > lastRead && row.alias !== undefined
                && !Message.fromDB(row).isExpired(now))
            .count();
    }

    async addRoom(room) {
        await this.db.room.add(room);
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

    async getRoom(roomId) {
        const roomDB = await this.db.room.where({id: roomId}).first();

        return Room.fromDB(roomDB);
    }

    async getRooms() {
        const rooms = await this.db.room.toArray();

        let roomsArray = [];

        rooms.forEach(room => {
            console.log(room);
            roomsArray.push(Room.fromDB(room));
        })

        return roomsArray;
    }

    // --- Cleanup ---

    async clear() {
        await this.db.profile.clear();
        await this.db.message.clear();
        await this.db.room.clear();
        await this.db.file.clear();
    }
}

// Same sender, type and content (all encrypted with the room key, so they can't be faked
// without changing the ciphertext)
function sameMessage(a, b) {
    return a.roomId === b.roomId && a.type === b.type && a.content === b.content
        && a.alias === b.alias && a.aliasId === b.aliasId;
}
