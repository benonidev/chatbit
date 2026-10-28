// Scenario tests of the room key protocol on the client (room_keys.js) with several clients and a
// fake server that follows the rules of internal/port/rooms.go. Run: node --test tests/js
import {test} from "node:test";
import assert from "node:assert/strict";
import {EventBus, Events} from "../../dist/assets/js/adapter/event.js";
import {AesAdapter} from "../../dist/assets/js/adapter/aes.js";
import {KeyStore} from "../../dist/assets/js/adapter/key_store.js";
import {RoomKeys} from "../../dist/assets/js/adapter/room_keys.js";
import {Room} from "../../dist/assets/js/domain/room.js";
import {Message} from "../../dist/assets/js/domain/message.js";
import {importJoinSecret, inviteCode, joinWindow, memberCode} from "../../dist/assets/js/adapter/join_code.js";

// -------------------------------------------------------------------------
// Client: the real KeyStore and RoomKeys on an in-memory database
// -------------------------------------------------------------------------

class MemoryDB {
    constructor() {
        this.profile = null;
        this.rooms = new Map();
        this.epochs = new Map();
        this.messages = new Map();
    }
    async addProfile(p) { this.profile = p.toDB(); }
    async getProfile() { return {...this.profile}; }
    async addRoom(room) {
        if (this.rooms.has(room.id)) throw Object.assign(new Error("exists"), {name: "ConstraintError"});
        this.rooms.set(room.id, {...(room.toJSON ? room.toJSON() : room)});
    }
    async getRoom(id) { return this.rooms.has(id) ? Room.fromDB(this.rooms.get(id)) : null; }
    async getRooms() { return [...this.rooms.values()].map(r => Room.fromDB(r)); }
    async updateRoomFields(id, changes) { if (this.rooms.has(id)) Object.assign(this.rooms.get(id), changes); }
    async removeRoom(id) {
        this.rooms.delete(id);
        for (const k of [...this.epochs.keys()]) if (k.startsWith(id + ":")) this.epochs.delete(k);
        for (const [k, m] of [...this.messages]) if (m.roomId === id) this.messages.delete(k);
    }
    async putEpoch(e) { this.epochs.set(`${e.roomId}:${e.epoch}`, {...e}); }
    async getEpoch(roomId, epoch) { return this.epochs.get(`${roomId}:${epoch}`); }
    async getAllEpochs() { return [...this.epochs.values()]; }
    async countMessagesByEpoch(roomId) {
        const counts = new Map();
        for (const m of this.messages.values()) {
            if (m.roomId === roomId && m.aliasId !== undefined) counts.set(m.epoch, (counts.get(m.epoch) ?? 0) + 1);
        }
        return counts;
    }
    async deleteEpoch(roomId, epoch) { this.epochs.delete(`${roomId}:${epoch}`); }
    async getMessage(id) { return this.messages.get(id); }
    async addMessage(m) { if (!this.messages.has(m.id)) this.messages.set(m.id, m.toJSON ? m.toJSON() : m); }
    async replaceMessage(m) { this.messages.set(m.id, m.toJSON()); }
    async cleanRoom(roomId) { for (const [id, m] of this.messages) if (m.roomId === roomId) this.messages.delete(id); }
    async getSystemMessages() { return [...this.messages.values()].filter(m => m.type === Message.TYPE_SYSTEM); }
}

async function newClient(alias) {
    const events = new EventBus();
    const db = new MemoryDB();
    const aes = new AesAdapter();
    const keyStore = new KeyStore(aes, db, events);
    await keyStore.register(alias, "password-" + alias);
    const roomKeys = new RoomKeys(events, db, keyStore, aes, {delay: () => 0});
    roomKeys.init();

    const client = {alias, events, db, keyStore, roomKeys, clientId: keyStore.clientId, online: true, received: [], requests: []};
    events.on(Events.WS.RECEIVED_MESSAGE, async msg => {
        if (!await db.getRoom(msg.roomId)) return; // like DatabaseAdapter: not for a deleted room
        if (!await roomKeys.acceptMessage(msg)) return; // and not with a wrong signature
        await db.addMessage(msg);
        client.received.push(msg);
    });
    events.on(Events.ROOM.JOIN_REQUEST, req => client.requests.push(req));
    return client;
}

// -------------------------------------------------------------------------
// Fake server: the rules of internal/port/rooms.go
// -------------------------------------------------------------------------

class FakeServer {
    constructor() {
        this.rooms = new Map();
    }

    attach(client) {
        const on = (event, fn) => client.events.on(event, data => { if (client.online) fn(data); });
        on(Events.WS.JOIN_ROOM, entry => this.join(client, entry));
        on(Events.WS.SEND_ROTATE, rot => this.rotate(client, rot));
        on(Events.WS.SEND_JOIN_REQUEST, req => this.joinRequest(client, req));
        on(Events.WS.SEND_KEY_UPDATE, u => this.keyUpdate(client, u));
        on(Events.WS.SEND_MESSAGE, msg => this.message(client, msg));
        on(Events.WS.LEAVE_ROOM, roomId => this.leave(client, roomId));
        // The frames of one connection are handled in order
        client.serverQueue = Promise.resolve();
    }

    _do(client, fn) {
        client.serverQueue = client.serverQueue.then(fn).catch(err => console.error("server", err));
    }

    send(client, event, data) {
        if (client.online) setTimeout(() => client.events.emit(event, structuredClone(data)), 0);
    }

    room(id) {
        return this.rooms.get(id);
    }

    join(client, entry) {
        this._do(client, async () => {
            let r = this.rooms.get(entry.id);
            if (!r) {
                r = {epoch: 0, J: null, peers: new Map([[client.clientId, {client, epoch: 0}]]), subs: new Set([client]), pending: new Set(), log: [], requests: []};
                this.rooms.set(entry.id, r);
                return this.send(client, Events.WS.ROOM_INFO, {id: entry.id, epoch: 0});
            }

            if (entry.memberCode) {
                if (r.epoch > 0 && entry.epoch === r.epoch && await validMember(r.J, entry.memberCode, client.clientId)) {
                    r.peers.set(client.clientId, {client, epoch: r.epoch});
                    r.pending.delete(client);
                    r.subs.add(client);
                    this.send(client, Events.WS.ROOM_INFO, {id: entry.id, epoch: r.epoch});
                    for (const request of r.requests) this.send(client, Events.WS.JOIN_REQUEST, {roomId: entry.id, request});
                    return;
                }
                const old = r.log.find(l => l.epoch === entry.epoch);
                if (old && entry.epoch < r.epoch && await validMember(old.J, entry.memberCode, client.clientId)) {
                    return this.send(client, Events.WS.JOIN_REJECTED, {id: entry.id, reason: "rotated", rotations: this._since(r, entry.id, entry.epoch)});
                }
                return this.send(client, Events.WS.JOIN_REJECTED, {id: entry.id, reason: "code"});
            }

            if (r.pending.has(client)) {
                if (entry.epoch < r.epoch) {
                    return this.send(client, Events.WS.JOIN_REJECTED, {id: entry.id, reason: "rotated", rotations: this._since(r, entry.id, entry.epoch)});
                }
                r.subs.add(client);
                return this.send(client, Events.WS.ROOM_INFO, {id: entry.id, epoch: r.epoch, pending: true});
            }

            if (r.epoch === 0 && r.peers.has(client.clientId)) {
                r.subs.add(client);
                return this.send(client, Events.WS.ROOM_INFO, {id: entry.id, epoch: 0});
            }
            this.send(client, Events.WS.JOIN_REJECTED, {id: entry.id, reason: "code"});
        });
    }

    _since(r, roomId, epoch) {
        return r.log.filter(l => l.epoch > epoch).map(l => ({roomId, epoch: l.epoch, body: l.body}));
    }

    isMember(r, client) {
        return r.peers.get(client.clientId)?.epoch === r.epoch && r.subs.has(client);
    }

    rotate(client, rot) {
        this._do(client, async () => {
            const r = this.rooms.get(rot.roomId);
            const creator = r.epoch === 0 && r.peers.has(client.clientId);
            if ((!creator && !this.isMember(r, client)) || rot.epoch !== r.epoch + 1) {
                return this.send(client, Events.WS.ROTATE_REJECTED, {roomId: rot.roomId, epoch: rot.epoch, current: r.epoch});
            }
            r.epoch = rot.epoch;
            r.J = rot.joinSecret;
            r.log.push({epoch: rot.epoch, J: rot.joinSecret, body: rot.body});

            for (const c of r.subs) this.send(c, Events.WS.ROTATION, {roomId: rot.roomId, epoch: rot.epoch, body: rot.body});
            for (const c of [...r.subs]) {
                if (r.pending.has(c)) continue;
                this.send(c, Events.WS.REJOIN_REQUIRED, {roomId: rot.roomId, epoch: rot.epoch});
                r.subs.delete(c);
            }
        });
    }

    joinRequest(client, req) {
        this._do(client, async () => {
            const r = this.rooms.get(req.roomId);
            if (!r || r.epoch === 0 || !await validInvite(r.J, req.inviteCode)) {
                return this.send(client, Events.WS.JOIN_REJECTED, {id: req.roomId, reason: "code"});
            }
            r.pending.add(client);
            r.subs.add(client);
            r.requests.push(req.request);
            this.send(client, Events.WS.ROOM_INFO, {id: req.roomId, epoch: r.epoch, pending: true});
            for (const c of r.subs) if (this.isMember(r, c)) this.send(c, Events.WS.JOIN_REQUEST, {roomId: req.roomId, request: req.request});
        });
    }

    keyUpdate(client, u) {
        this._do(client, async () => {
            const r = this.rooms.get(u.roomId);
            if (!this.isMember(r, client) || u.epoch !== r.epoch) return;
            for (const c of r.subs) if (c !== client) this.send(c, Events.WS.KEY_UPDATE, u);
        });
    }

    message(client, msg) {
        this._do(client, async () => {
            const r = this.rooms.get(msg.roomId);
            if (!this.isMember(r, client) || msg.epoch !== r.epoch) {
                return this.send(client, Events.WS.MESSAGE_REJECTED, {id: msg.id, roomId: msg.roomId, reason: "epoch"});
            }
            const {timestamp, synced, ...data} = msg.toJSON();
            for (const c of r.subs) {
                if (!this.isMember(r, c)) continue;
                setTimeout(() => c.events.emit(Events.WS.RECEIVED_MESSAGE, Message.fromJSON({...data, synced: true, timestamp: Date.now()})), 0);
            }
        });
    }

    leave(client, roomId) {
        this._do(client, async () => {
            const r = this.rooms.get(roomId);
            if (!r) return;
            r.peers.delete(client.clientId);
            r.pending.delete(client);
            r.subs.delete(client);
        });
    }

    disconnect(client) {
        client.online = false;
        for (const r of this.rooms.values()) r.subs.delete(client);
    }

    // Like WebSocketAdapter._onOpen: join every room again
    async reconnect(client) {
        client.online = true;
        client.events.emit(Events.WS.CONNECTED);
        for (const room of await client.db.getRooms()) {
            const entry = await client.keyStore.joinEntry(room, client.clientId);
            if (entry) this.join(client, entry);
        }
    }
}

async function validMember(J, code, clientId) {
    if (!J) return false;
    const key = await importJoinSecret(J);
    const nonce = code.split(".")[0];
    const w = joinWindow();
    for (const window of [w - 1, w, w + 1]) {
        if (await memberCode(key, window, clientId, nonce) === code) return true;
    }
    return false;
}

async function validInvite(J, code) {
    if (!J) return false;
    const key = await importJoinSecret(J);
    const nonce = code.split(".")[0];
    return await inviteCode(key, joinWindow(), nonce) === code;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Waits until fn() is true (the protocol runs asynchronously over several frames)
async function until(fn, what, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(20);
    }
    assert.fail("timeout: " + what);
}

async function room(client, id) {
    return client.db.getRoom(id);
}

async function rosterAliases(client, id) {
    return (await client.roomKeys.members(id)).map(m => m.alias).sort();
}

// Invites `guest` with an invite of `host` and approves the request
async function invite(host, guest, roomId) {
    const {invite} = await host.roomKeys.newInvite(roomId);
    await guest.roomKeys.joinByInvite(invite);
    await until(() => host.requests.some(r => r.roomId === roomId && r.entry.alias === guest.alias), `${host.alias} sees the request of ${guest.alias}`);
    const req = host.requests.find(r => r.roomId === roomId && r.entry.alias === guest.alias);
    host.events.emit(Events.ROOM.APPROVE, {roomId, entry: req.entry});
    await until(async () => (await room(guest, roomId))?.isMember() && guest.roomKeys.isReady(roomId, (await room(guest, roomId)).epoch), `${guest.alias} is a member`);
}

async function send(client, roomId, text) {
    const msg = await client.roomKeys.encryptMessage(roomId, {type: Message.TYPE_TEXT, content: text, ttl: 3600});
    client.events.emit(Events.WS.SEND_MESSAGE, msg);
    return msg;
}

async function readBy(client, text) {
    for (const m of client.received) {
        const plain = await client.roomKeys.decryptMessage(m);
        if (plain?.content === text) return plain;
    }
    return null;
}

// -------------------------------------------------------------------------
// Scenario
// -------------------------------------------------------------------------

test("create, invite with approval, messages, kick, offline catch-up, concurrent rotations, resend, leave", async () => {
    const server = new FakeServer();
    const alice = await newClient("alice"), dave = await newClient("dave"), carol = await newClient("carol");
    for (const c of [alice, dave, carol]) server.attach(c);

    // Alice creates the room: epoch 1, she is the only member
    const id = await alice.roomKeys.createRoom({name: "team", pushNotifications: false, store: true, ttl: 3600});
    await until(async () => (await room(alice, id)).epoch === 1 && alice.roomKeys.isReady(id, 1), "room created");
    assert.deepEqual(await rosterAliases(alice, id), ["alice"]);

    // Dave joins with Alice's invite; while he waits he can not send
    const {invite: inv} = await alice.roomKeys.newInvite(id);
    await dave.roomKeys.joinByInvite(inv);
    await until(() => alice.requests.length === 1, "join request shown to alice");
    assert.equal((await room(dave, id)).status, Room.STATUS_PENDING);
    assert.equal(await dave.roomKeys.encryptMessage(id, {type: 0, content: "too early"}), null);
    assert.equal(alice.requests[0].fingerprint.length, 19);

    alice.events.emit(Events.ROOM.APPROVE, {roomId: id, entry: alice.requests[0].entry});
    await until(async () => (await room(dave, id)).isMember() && dave.roomKeys.isReady(id, 2), "dave approved");
    await until(async () => alice.roomKeys.isReady(id, 2), "alice in epoch 2");
    assert.deepEqual(await rosterAliases(dave, id), ["alice", "dave"]);

    // Signed messages in both directions
    await send(dave, id, "hi from dave");
    await until(() => readBy(alice, "hi from dave"), "alice reads dave");
    const fromDave = await readBy(alice, "hi from dave");
    assert.equal(fromDave.verified, true);
    assert.equal(fromDave.alias, "dave");

    // A new profile alias does not rename Dave in this room: the name comes from the roster
    dave.db.profile.name = "boss";
    await send(dave, id, "still dave");
    await until(() => readBy(alice, "still dave"), "alice reads dave again");
    assert.equal((await readBy(alice, "still dave")).alias, "dave");

    // Dave writes under Alice's member id, and with an alias field (as messages had before):
    // the signature does not fit — Alice does not store or show either message
    const aes = new AesAdapter();
    const {keys} = await dave.roomKeys.currentKeys(id);
    const aliceId = await alice.roomKeys.ownMemberId(id);
    const asAlice = await dave.roomKeys.encryptMessage(id, {type: Message.TYPE_TEXT, content: "i am alice", ttl: 3600});
    asAlice.aliasId = await aes.encryptPadded(aliceId, keys.messageKey);
    const withAlias = await dave.roomKeys.encryptMessage(id, {type: Message.TYPE_TEXT, content: "i am admin", ttl: 3600});
    withAlias.alias = await aes.encryptPadded("admin", keys.messageKey);
    for (const forged of [asAlice, withAlias]) dave.events.emit(Events.WS.SEND_MESSAGE, forged);
    await send(dave, id, "after the forgeries");
    await until(() => readBy(alice, "after the forgeries"), "alice reads the next message");
    for (const forged of [asAlice, withAlias]) {
        assert.equal(await alice.db.getMessage(forged.id), undefined, "forged message not stored");
    }
    assert.equal(await readBy(alice, "i am alice"), null);
    assert.equal(await readBy(alice, "i am admin"), null);

    // Alice answers Dave; the reply points to his message (signed). Moving it under another
    // message breaks the signature — Dave drops that copy.
    const answered = (await Promise.all(alice.received.map(async m => ({m, p: await alice.roomKeys.decryptMessage(m)}))))
        .find(x => x.p?.content === "still dave").m;
    const reply = await alice.roomKeys.encryptMessage(id, {type: Message.TYPE_TEXT, content: "re: still dave", replyTo: answered.id, ttl: 3600});
    alice.events.emit(Events.WS.SEND_MESSAGE, reply);
    await until(() => readBy(dave, "re: still dave"), "dave reads the reply");
    assert.equal((await readBy(dave, "re: still dave")).replyTo, answered.id);

    const aliceKeys = (await alice.roomKeys.currentKeys(id)).keys;
    const moved = await alice.roomKeys.encryptMessage(id, {type: Message.TYPE_TEXT, content: "moved reply", replyTo: answered.id, ttl: 3600});
    moved.reply = await aes.encryptPadded(reply.id, aliceKeys.messageKey);
    alice.events.emit(Events.WS.SEND_MESSAGE, moved);
    await send(alice, id, "after the moved reply");
    await until(() => readBy(dave, "after the moved reply"), "dave reads the next message");
    assert.equal(await dave.db.getMessage(moved.id), undefined, "moved reply not stored");

    // Dave invites Carol (the inviter approves)
    await invite(dave, carol, id);
    await until(async () => alice.roomKeys.isReady(id, 3), "alice in epoch 3");
    assert.deepEqual(await rosterAliases(alice, id), ["alice", "carol", "dave"]);

    // Carol goes offline; Alice removes Dave — Dave is out even though he is connected
    server.disconnect(carol);
    await alice.roomKeys.removeMember(id, (await alice.roomKeys.members(id)).find(m => m.alias === "dave").memberId);
    await until(async () => (await room(dave, id))?.isRemoved(), "dave removed");
    await until(async () => alice.roomKeys.isReady(id, 4), "alice in epoch 4");
    assert.equal(server.room(id).peers.has(dave.clientId), false, "the removed device left on the server");

    // Key history: every epoch with its reason, who did it and the members
    const history = await alice.roomKeys.history(id);
    assert.deepEqual(history.map(h => [h.epoch, h.reason, h.signer?.alias, h.subject?.alias ?? null]), [
        [4, "remove", "alice", "dave"],
        [3, "add", "dave", "carol"],
        [2, "add", "alice", "dave"],
        [1, "create", "alice", null],
    ]);
    assert.equal(history[0].current, true);
    assert.equal(history[0].signer.own, true);
    assert.deepEqual(history[0].removed.map(m => m.alias), ["dave"]);
    assert.deepEqual(history[0].members.map(m => m.alias).sort(), ["alice", "carol"]);
    assert.equal(history[0].prevHash, history[1].headerHash, "the epochs are chained");
    assert.ok(history[2].messages >= 2, "messages of epoch 2 are counted");
    // Dave only knows the epochs since he joined
    assert.deepEqual((await dave.roomKeys.history(id)).map(h => h.epoch), [3, 2]);

    await send(alice, id, "after dave");
    await until(() => readBy(alice, "after dave"), "alice gets her echo");
    assert.equal(dave.received.some(m => m.epoch === 4), false, "dave gets nothing of epoch 4");

    // Carol comes back: she catches up from epoch 3 to 4 and joins again
    await server.reconnect(carol);
    await until(async () => (await room(carol, id)).epoch === 4 && carol.roomKeys.isReady(id, 4), "carol caught up");
    assert.deepEqual(await rosterAliases(carol, id), ["alice", "carol"]);

    // Both rotate at the same time: one wins, both end in the same epoch with the same keys
    await Promise.all([
        alice.roomKeys._addIntent(id, {reason: "renew"}, 0),
        carol.roomKeys._addIntent(id, {reason: "renew"}, 0),
    ]);
    await until(async () => {
        const [a, c] = [await room(alice, id), await room(carol, id)];
        return a.epoch === c.epoch && a.epoch >= 5 && alice.roomKeys.isReady(id, a.epoch) && carol.roomKeys.isReady(id, c.epoch);
    }, "both in the same epoch after concurrent rotations");
    const epoch = (await room(alice, id)).epoch;
    assert.equal((await alice.keyStore.getEpoch(id, epoch)).K, (await carol.keyStore.getEpoch(id, epoch)).K);

    // A message that was on its way during a rotation is sent again in the new epoch
    const late = await alice.roomKeys.encryptMessage(id, {type: Message.TYPE_TEXT, content: "late", ttl: 3600});
    await alice.db.addMessage(late);
    await carol.roomKeys._addIntent(id, {reason: "renew"}, 0);
    await until(async () => (await room(carol, id)).epoch === epoch + 1 && alice.roomKeys.isReady(id, epoch + 1), "rotated once more");
    alice.events.emit(Events.WS.SEND_MESSAGE, late);
    await until(() => readBy(carol, "late"), "carol gets the resent message");
    assert.equal((await readBy(carol, "late")).verified, true);

    // Carol leaves: Alice rotates without her
    await carol.roomKeys.leave(id);
    await until(async () => (await rosterAliases(alice, id)).join() === "alice", "alice alone again");
    assert.equal(await room(carol, id), null);
    assert.equal(carol.db.epochs.size, 0, "no epoch keys left in the database");
    assert.equal([...carol.db.messages.values()].filter(m => m.roomId === id).length, 0, "no messages left");
    assert.equal(await carol.keyStore.getBase(id), null, "no base key left in memory");
    assert.equal(await carol.keyStore.getEpoch(id, epoch), null, "no epoch keys left in memory");

    // System messages tell what happened
    const texts = [];
    for (const m of await alice.db.getSystemMessages()) texts.push(await alice.keyStore.openLocal(m.content));
    assert.ok(texts.includes("Room created"), texts.join(" | "));
    assert.ok(texts.includes("You added dave"), texts.join(" | "));
    assert.ok(texts.includes("dave added carol"), texts.join(" | "));
    assert.ok(texts.includes("You removed dave"), texts.join(" | "));
    assert.ok(texts.includes("carol left the room"), texts.join(" | "));
});
