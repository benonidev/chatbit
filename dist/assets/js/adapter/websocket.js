import {Events} from "./event.js";
import {Message} from "../domain/message.js";
import {File} from "../domain/file.js";
import {logger} from "./log.js";

const log = logger("ws");

const CHUNK_SIZE = 64 * 1024; // 64KB

// Reconnect backoff: starts at RECONNECT_DELAY_MIN and doubles up to RECONNECT_DELAY_MAX.
const RECONNECT_DELAY_MIN = 1000;
const RECONNECT_DELAY_MAX = 30000;

// How often a failed file upload is retried after a reconnect.
const FILE_UPLOAD_ATTEMPTS = 3;

// Pure transport layer — no decryption, no DB writes, no business logic.
// Emits raw events; a higher layer (views / database adapter) processes them.
//
// The connection is opened after the profile is unlocked and is kept alive
// automatically: on every close it reconnects with exponential backoff, and
// it reconnects immediately when the browser comes back online or the app
// becomes visible again. After every (re)connect all rooms are joined again
// and messages missed while offline are fetched per room from its cursor (Room.syncedUntil, the
// server time of the newest message received — never the client clock).
//
// Events emitted:
//   Events.WS.CONNECTED                — socket opened and rooms joined (every reconnect)
//   Events.WS.READY                    — first successful connection after unlock
//   Events.WS.RECEIVED_MESSAGE (Message) — message received from the server
//   Events.WS.RECEIVED_FILE    (File)    — assembled binary transfer
//   Events.WS.ROOM_CLEANED     ({id, timestamp}) — another member cleaned the room
//   Events.WS.JOINING ([id]), ROOM_SYNCED ({id, until}) — cursor of the missed messages (database.js)
//   Events.WS.JOIN_REJECTED    ({id, reason, rotations?}) — no valid join code / catch up
//   Events.WS.ROTATION, ROTATE_REJECTED, REJOIN_REQUIRED, JOIN_REQUEST, KEY_UPDATE,
//   MESSAGE_REJECTED                             — room keys with epochs (room_keys.js)
export class WebSocketAdapter {
    constructor(events, db, keyStore) {
        this.conn = null;
        this._events = events;
        this._db = db;
        this._keyStore = keyStore; // join entries (epoch + member code) of the rooms

        // Connection state
        this._profile = null;
        this._ready = false;
        this._reconnectDelay = RECONNECT_DELAY_MIN;
        this._reconnectTimer = null;
        this._openWaiters = [];

        // Text frames that were sent while the socket was not open
        this._outbox = [];

        // File transfer state
        this._pendingAck = null;
        this._bufferedAcks = new Map();
        this._incomingTransfers = new Map();
    }

    _getEndpoint() {
        const protocol = location.protocol === "https:" ? "wss://" : "ws://";
        return `${protocol}${document.location.host}/ws`;
    }

    // Opens the connection once the profile is unlocked (only the first unlock counts).
    handler = (profile) => {
        this._events.off(Events.STATE.UNLOCK, this.handler);

        this._profile = profile;
        this._watchNetwork();
        this._connect();
    };

    init() {
        this._events.on(Events.STATE.UNLOCK, this.handler);

        this._events.on(Events.WS.SEND_FILE, async (msg) => {
            await this._uploadFile(msg);
        });

        this._events.on(Events.WS.SEND_MESSAGE, async (msg) => {
            this.sendMessage(msg);
        });

        this._events.on(Events.WS.SEND_ROTATE, (data) => this._sendText("rotate", data));
        this._events.on(Events.WS.SEND_JOIN_REQUEST, (data) => this._sendText("join_request", data));
        this._events.on(Events.WS.SEND_KEY_UPDATE, (data) => this._sendText("key_update", data));
        this._events.on(Events.WS.SEND_ANSWER_REQUEST, (data) => this._sendText("answer_request", data));

        // body: {id, epoch, memberCode?, notification, ttl?, store?}
        this._events.on(Events.WS.JOIN_ROOM, async (room) => {
            this.joinRooms({
                rooms: [room],
                lastConnectionTime: 0,
            });
        });

        // body: room id
        this._events.on(Events.WS.LEAVE_ROOM, async (roomId) => {
            this.leaveRooms({rooms: [roomId]});
        });

        // body: room id
        this._events.on(Events.WS.CLEAN_ROOM, async (roomId) => {
            this.cleanRoom({id: roomId});
        });

        this._events.on(Events.WS.TRANSFER_REQUEST, async (msg) => {
            this.transferRequest(msg);
        });

        this._events.on(Events.WS.SUBSCRIBE_PUSH, async (subPush) => {
            this.subscribePush(subPush);
        });
    }

    // -------------------------------------------------------------------------
    // Connection handling
    // -------------------------------------------------------------------------

    isOpen() {
        return this.conn !== null && this.conn.readyState === WebSocket.OPEN;
    }

    // Resolves as soon as the socket is open (immediately if it already is).
    _whenOpen() {
        if (this.isOpen()) return Promise.resolve();
        return new Promise(resolve => this._openWaiters.push(resolve));
    }

    _connect() {
        if (!window["WebSocket"]) {
            log.error("WebSockets are not supported");
            return;
        }

        // Already open or a connection attempt is in progress
        if (this.conn !== null &&
            (this.conn.readyState === WebSocket.OPEN || this.conn.readyState === WebSocket.CONNECTING)) {
            return;
        }

        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        // The client id is sent in the first frame (hello), not in the URL — URLs end up in proxy logs
        const conn = new WebSocket(this._getEndpoint());
        conn.binaryType = "arraybuffer";
        this.conn = conn;

        conn.onopen = () => this._onOpen();

        conn.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                this._handleIncomingChunk(e.data);
                return;
            }
            for (const text of e.data.split('\n')) {
                if (!text.trim()) continue;
                try {
                    this._handleIncomingMessage(JSON.parse(text));
                } catch (err) {
                    log.error("invalid frame from the server:", err.message);
                }
            }
        };

        // The browser always fires "close" after "error", so reconnecting is handled there.
        conn.onerror = (err) => {
            log.warn("connection error");
        };

        conn.onclose = (evt) => {
            // Ignore close events of an old socket that was already replaced
            if (this.conn !== conn) return;

            log.info("connection closed", evt.code, evt.reason);
            this._failTransfers();
            this._scheduleReconnect();
        };
    }

    async _onOpen() {
        log.info("connected");
        this._reconnectDelay = RECONNECT_DELAY_MIN;

        // Must be the first frame of every connection, before anything from the outbox
        this.conn.send(JSON.stringify({type: "hello", data: {clientUid: this._profile.clientId}}));

        // The server forgets all subscriptions when the socket closes,
        // so all rooms have to be joined again after every reconnect.
        try {
            await this._joinAllRooms();
        } catch (err) {
            log.error("joining the rooms failed:", err);
        }

        this._flushOutbox();

        this._openWaiters.splice(0).forEach(resolve => resolve());
        this._events.emit(Events.WS.CONNECTED);

        if (!this._ready) {
            this._ready = true;
            this._events.emit(Events.WS.READY);
        }
    }

    // Joins all locally stored rooms (members with a code of their newest epoch, waiting new
    // members without). Every entry carries `since`: the missed messages come per room.
    async _joinAllRooms() {
        const rooms = await this._db.getRooms();

        const joins = [];
        for (const r of rooms) {
            const entry = await this._keyStore.joinEntry(r, this._profile.clientId);
            if (entry) joins.push(entry);
        }

        log.debug(`joining ${joins.length} rooms`);
        this.joinRooms({
            rooms: joins,
            lastConnectionTime: 0, // only for rooms without `since` (a new room)
        });
    }

    _scheduleReconnect() {
        if (this._reconnectTimer !== null) return;

        const delay = this._reconnectDelay;
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_DELAY_MAX);

        log.info(`reconnecting in ${delay} ms`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, delay);
    }

    // Skips the backoff and reconnects right away (e.g. network is back).
    _reconnectNow() {
        if (this._profile === null || this.isOpen()) return;

        this._reconnectDelay = RECONNECT_DELAY_MIN;
        this._connect();
    }

    // Mobile browsers suspend background tabs and drop the socket, so reconnect
    // as soon as the network is back or the app is visible again.
    _watchNetwork() {
        window.addEventListener("online", () => this._reconnectNow());

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") this._reconnectNow();
        });
    }

    // -------------------------------------------------------------------------
    // Outgoing messages
    // -------------------------------------------------------------------------

    // Sends a text frame, or queues it until the socket is open again.
    _sendText(type, data) {
        const frame = JSON.stringify({type, data});

        if (this.isOpen()) {
            this.conn.send(frame);
        } else {
            this._outbox.push(frame);
        }
    }

    _flushOutbox() {
        for (const frame of this._outbox.splice(0)) {
            this.conn.send(frame);
        }
    }

    // The server sets the timestamp. The local one is not sent: the clock offset of a device is
    // a fingerprint that would make it recognizable across rooms. "synced" is only local.
    sendMessage(msg) {
        const {timestamp, synced, ...data} = msg.toJSON ? msg.toJSON() : msg;
        this._sendText("message", data);
    }

    joinRooms(msg) {
        this._events.emit(Events.WS.JOINING, msg.rooms.map(r => r.id));
        this._sendText("join_rooms", msg);
    }

    leaveRooms(msg) {
        this._sendText("leave_rooms", msg);
    }

    cleanRoom(msg) {
        this._sendText("clean_room", msg);
    }

    subscribePush(msg) {
        this._sendText("sub_push", msg);
    }

    // request image or data from server
    transferRequest(msg) {
        this._sendText("transfer_request", msg);
    }

    // start to send image or data to server
    transferStart(msg) {
        this._sendText("transfer_start", msg);
    }

    // -------------------------------------------------------------------------
    // Incoming message dispatch
    // -------------------------------------------------------------------------

    _handleIncomingMessage(msg) {
        switch (msg.type) {
            case "message":
                msg.data.synced = true;

                this._events.emit(Events.WS.RECEIVED_MESSAGE, Message.fromJSON(msg.data));
                break;
            case "room_info":
                this._events.emit(Events.WS.ROOM_INFO, msg.data);
                break;
            case "room_synced":
                this._events.emit(Events.WS.ROOM_SYNCED, msg.data);
                break;
            case "join_rejected":
                this._events.emit(Events.WS.JOIN_REJECTED, msg.data);
                break;
            case "rotation":
                this._events.emit(Events.WS.ROTATION, msg.data);
                break;
            case "rotate_rejected":
                this._events.emit(Events.WS.ROTATE_REJECTED, msg.data);
                break;
            case "rejoin_required":
                this._events.emit(Events.WS.REJOIN_REQUIRED, msg.data);
                break;
            case "join_request":
                this._events.emit(Events.WS.JOIN_REQUEST, msg.data);
                break;
            case "key_update":
                this._events.emit(Events.WS.KEY_UPDATE, msg.data);
                break;
            case "message_rejected":
                this._events.emit(Events.WS.MESSAGE_REJECTED, msg.data);
                break;
            case "clean_room":
                this._events.emit(Events.WS.ROOM_CLEANED, msg.data);
                break;
            case "transfer_ack":
                this.resolveAck(msg.data.id, msg.data.chunk);
                break;
            case "transfer_nack":
                // The server rejected the upload (e.g. too large) — stop waiting for an ACK
                log.warn("upload rejected by the server:", msg.data.reason);
                this.rejectAck(msg.data.id, msg.data.reason);
                break;
            case "transfer_start":
                this._handleTransferStart(
                    msg.data.id, msg.data.roomId, msg.data.mimeType,
                    msg.data.timestamp, msg.data.chunksTotal, msg.data.chunkSize
                );
                break;
            case "transfer_done":
                this._assembleTransfer(msg.data.id);
                break;
            default:
                log.warn("unknown frame type:", msg.type);
        }
    }

    // -------------------------------------------------------------------------
    // Incoming binary transfer
    // -------------------------------------------------------------------------

    _handleTransferStart(id, roomId, mimeType, timestamp, chunksTotal, chunkSize) {
        log.debug("download started", id, chunksTotal, "chunks");
        this._incomingTransfers.set(id, {
            roomId, mimeType, timestamp,
            chunks: new Array(chunksTotal).fill(null),
            chunkSize,
            received: 0,
            chunksTotal,
        });
    }

    _handleIncomingChunk(data) {
        const view = new DataView(data);
        const uuidBytes = new Uint8Array(data, 0, 16);
        const id = [
            uuidBytes.slice(0, 4), uuidBytes.slice(4, 6),
            uuidBytes.slice(6, 8), uuidBytes.slice(8, 10),
            uuidBytes.slice(10, 16),
        ].map(b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')).join('-');

        const chunkId = view.getUint32(16, false);
        const encrypted = data.slice(20);

        const t = this._incomingTransfers.get(id);
        if (!t) return;
        t.chunks[chunkId] = encrypted;
        t.received++;
    }

    // Assembles chunks into a single buffer and emits Events.WS.RECEIVED_FILE.
    // No DB access — the consumer saves the file.
    _assembleTransfer(fileId) {
        const t = this._incomingTransfers.get(fileId);
        if (!t) {
            log.warn("end of an unknown transfer", fileId);
            return;
        }

        const totalLength = t.chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of t.chunks) {
            combined.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        }
        this._incomingTransfers.delete(fileId);

        const fileM = new File({
            id: fileId,
            roomId: t.roomId,
            mimeType: t.mimeType,
            timestamp: t.timestamp,
            blob: combined.buffer,
            chunkSize: t.chunkSize,
            ttl: t.ttl,
            store: t.store,
            totalSize: t.totalSize,
        });

        this._events.emit(Events.WS.RECEIVED_FILE, fileM);
    }

    // -------------------------------------------------------------------------
    // Outgoing binary transfer
    // -------------------------------------------------------------------------

    // Uploads a file; if the connection drops during the upload it waits for the
    // reconnect and starts the upload again from the first chunk.
    async _uploadFile(msg) {
        for (let attempt = 1; attempt <= FILE_UPLOAD_ATTEMPTS; attempt++) {
            await this._whenOpen();
            try {
                this.transferStart(msg);
                await this.sendFile(msg);
                return;
            } catch (err) {
                log.warn(`upload failed (attempt ${attempt}/${FILE_UPLOAD_ATTEMPTS}):`, err.message);
                if (err.message.startsWith("rejected by server")) break; // trying again won't help
            }
        }
        log.error("upload failed, giving up");
    }

    // Sends all chunks; each chunk is only sent after the server acknowledged the previous one.
    async sendFile(msg) {
        for (let i = 0; i < msg.chunksTotal; i++) {
            await this.waitForAck(msg.id, i);
            const chunk = msg.blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            const header = this._encodeChunkHeader(msg.id, i);
            this._sendBinary(this._concat(header, chunk));
        }
        this._sendBinary(JSON.stringify({type: 'transfer_done', data: {id: msg.id}}));
    }

    // Binary transfers can not be queued — the server keeps the transfer state per connection.
    _sendBinary(data) {
        if (!this.isOpen()) throw new Error("WS connection is not open");
        this.conn.send(data);
    }

    _encodeChunkHeader(id, index) {
        const buf = new ArrayBuffer(20);
        const view = new DataView(buf);
        const uuidBytes = id.replace(/-/g, '').match(/.{2}/g).map(h => parseInt(h, 16));
        uuidBytes.forEach((b, i) => view.setUint8(i, b));
        view.setUint32(16, index, false); // big-endian
        return buf;
    }

    _concat(a, b) {
        const tmp = new Uint8Array(a.byteLength + b.byteLength);
        tmp.set(new Uint8Array(a), 0);
        tmp.set(new Uint8Array(b), a.byteLength);
        return tmp.buffer;
    }

    // -------------------------------------------------------------------------
    // Flow control — ACK/NACK for outgoing chunks
    // -------------------------------------------------------------------------

    resolveAck(id, chunkIndex) {
        if (this._pendingAck &&
            id === this._pendingAck.id &&
            chunkIndex === this._pendingAck.chunkIndex) {
            this._pendingAck.resolve();
            this._pendingAck = null;
        } else {
            this._bufferedAcks.set(`${id}:${chunkIndex}`, true);
        }
    }

    rejectAck(id, reason) {
        if (this._pendingAck && this._pendingAck.id === id) {
            this._pendingAck.reject(new Error(`rejected by server: ${reason || "unknown"}`));
            this._pendingAck = null;
        }
    }

    waitForAck(id, chunkIndex) {
        const key = `${id}:${chunkIndex}`;
        if (this._bufferedAcks.has(key)) {
            this._bufferedAcks.delete(key);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this._pendingAck = {id, chunkIndex, resolve, reject};
        });
    }

    // Called when the socket closes: transfers are bound to the connection on the
    // server, so a running upload is aborted and partial downloads are dropped.
    _failTransfers() {
        if (this._pendingAck) {
            this._pendingAck.reject(new Error("WS connection closed"));
            this._pendingAck = null;
        }
        this._bufferedAcks.clear();
        this._incomingTransfers.clear();
    }
}
