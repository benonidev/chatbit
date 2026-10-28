// domain/message.js
// Represents a single chat message — always holds decrypted values
// Encryption/decryption is handled by the adapter layer, not here

import {formatBytes} from "./file.js";

// "PDF · 1.4 MB" — type from the file extension or, for images, from the MIME type
// (a document name can be very long, it is only used when the document is saved)
function fileDetails(info) {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(info.name || "")?.[1]
        ?? ({"image/jpeg": "jpg", "image/svg+xml": "svg"}[info.type]
            || /^[a-z]+\/([a-z0-9]{1,5})$/i.exec(info.type || "")?.[1]);
    return [ext?.toUpperCase(), info.size ? formatBytes(info.size) : ""].filter(Boolean).join(" · ");
}

// content of image and document messages: encrypted JSON {name?, type?, size}; older image
// messages have none
function parseFileInfo(content) {
    try {
        return JSON.parse(content) ?? {};
    } catch {
        return {};
    }
}

export class Message {
    static TYPE_TEXT   = 0;
    static TYPE_IMAGE  = 1;
    static TYPE_FILE   = 2;  // document; content is the encrypted JSON {name, size}
    static TYPE_LEAVE  = 3;  // the sender leaves the room — the others rotate without it
    static TYPE_CLEAN  = 4;  // the sender cleared the chat for everyone — shown as "Alice cleared the chat"
    static TYPE_SYSTEM = 10; // local only: "Alice added Dave" — content encrypted with the master key

    // Longest time a message is kept (seconds) — same limit as the server
    static MAX_TTL = 60 * 60 * 24 * 30;

    constructor({ id, roomId, aliasId, alias, content, timestamp, synced, type, ttl, store, epoch, sig, reply,
                  mimeType, totalSize, chunkSize, chunksTotal }) {
        this.id          = id ?? crypto.randomUUID();
        this.roomId      = roomId;
        this.aliasId     = aliasId;
        this.alias       = alias;
        this.content     = content;
        this.timestamp   = timestamp ?? Date.now();
        this.synced      = synced ?? false;
        this.type        = type ?? Message.TYPE_TEXT;
        this.ttl         = ttl ?? 0;
        this.store       = store ?? false;
        // Epoch whose room key encrypted alias, aliasId (the member id of the sender), content and
        // sig (the sender's Ed25519 signature) — see docs/room-keys.md
        this.epoch       = epoch ?? 0;
        this.sig         = sig;
        // Encrypted id of the message this one answers (undefined: no reply)
        this.reply       = reply;
        // File-only fields (undefined for text messages)
        this.mimeType    = mimeType;
        this.totalSize   = totalSize;
        this.chunkSize   = chunkSize;
        this.chunksTotal = chunksTotal;
    }

    // -------------------------------------------------------------------------
    // Factories — JSON → Message
    // -------------------------------------------------------------------------

    // From a decrypted DB row or decrypted WS payload
    // The adapter decrypts alias, alias_id and message before calling this
    static fromJSON(row) {
        return new Message({
            // Required fields
            id:        row.id,
            roomId:    row.roomId,
            aliasId:   row.aliasId,
            alias:     row.alias,
            content:   row.content,
            timestamp: row.timestamp,
            synced:    row.synced,
            type:      row.type,
            ttl:       row.ttl,
            store:     row.store,
            epoch:     row.epoch,
            sig:       row.sig,
            reply:     row.reply,
            // Optional file fields — undefined when not present, that is fine
            mimeType:    row.mimeType,
            totalSize:   row.totalSize,
            chunkSize:   row.chunkSize,
            chunksTotal: row.chunksTotal,
        });
    }

    static fromDB(row) {
        return new Message({
            // Required fields
            id:        row.id,
            roomId:    row.roomId,
            aliasId:   row.aliasId,
            alias:     row.alias,
            content:   row.content,
            timestamp: row.timestamp,
            synced:    row.synced,
            type:      row.type,
            ttl:       row.ttl,
            store:     row.store,
            epoch:     row.epoch,
            sig:       row.sig,
            reply:     row.reply,
            // Optional file fields — undefined when not present, that is fine
            mimeType:    row.mimeType,
            totalSize:   row.totalSize,
            chunkSize:   row.chunkSize,
            chunksTotal: row.chunksTotal,
        });
    }

    // -------------------------------------------------------------------------
    // Serialization — Message → JSON (adapter encrypts fields before storing/sending)
    // -------------------------------------------------------------------------

    toJSON() {
        const json = {
            id:        this.id,
            roomId:    this.roomId,
            aliasId:   this.aliasId,
            alias:     this.alias,
            content:   this.content,
            timestamp: this.timestamp,
            synced:    this.synced,
            type:      this.type,
            ttl:       this.ttl,
            store:     this.store,
            epoch:     this.epoch,
            sig:       this.sig,
        };

        if (this.reply       != null) json.reply       = this.reply;
        // File-only fields — only included when present
        if (this.mimeType    != null) json.mimeType    = this.mimeType;
        if (this.totalSize   != null) json.totalSize   = this.totalSize;
        if (this.chunkSize   != null) json.chunkSize   = this.chunkSize;
        if (this.chunksTotal != null) json.chunksTotal = this.chunksTotal;

        return json;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    isRoom(roomId) { return this.roomId === roomId; }

    isImage()    { return this.type === Message.TYPE_IMAGE; }

    isFile()     { return this.type === Message.TYPE_FILE; }

    isSystem()   { return this.type === Message.TYPE_SYSTEM; }

    isClean()    { return this.type === Message.TYPE_CLEAN; }

    // Shown in the chat (the leave message is only a signal for the other members)
    isVisible()  { return this.type !== Message.TYPE_LEAVE; }

    // TTL in seconds; 0 (unknown, e.g. old messages) means the maximum
    get effectiveTTL() {
        return this.ttl > 0 ? Math.min(this.ttl, Message.MAX_TTL) : Message.MAX_TTL;
    }

    // Time (ms) at which the message is deleted on every device
    get expiresAt() { return this.timestamp + this.effectiveTTL * 1000; }

    isExpired(now = Date.now()) { return this.expiresAt <= now; }

    get date()          { return new Date(this.timestamp); }
    get formattedTime() { return this.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    get formattedDate() { return this.date.toDateString(); }


    // -------------------------------------------------------------------------
    // Private rendering helpers
    // -------------------------------------------------------------------------

    _renderBubble(content) {
        if (this.isImage()) {
            const details = content ? fileDetails(parseFileInfo(content)) : "";
            return `<button type="button" class="btn btn-sm msg-image-btn"
                        data-action="chat:open_image"
                        data-body="${this.id}"
                    >
                        <ion-icon name="image-outline"></ion-icon> Image
                        ${details ? `<span class="msg-file-size">${this._escape(details)}</span>` : ""}
                    </button>`;
        }

        if (this.isFile()) {
            const info = parseFileInfo(content);
            return `<button type="button" class="btn btn-sm msg-image-btn msg-file-btn"
                        data-action="chat:open_file"
                        data-body="${this.id}"
                        title="Download"
                    >
                        <ion-icon name="document-outline"></ion-icon> Document
                        <span class="msg-file-size">${this._escape(fileDetails(info))}</span>
                    </button>`;
        }

        const conR = this._escape(content);
        return conR;
    }

    _renderStatus() {
        return this.synced
            ? '<ion-icon class="msg-status" name="checkmark-done-outline"></ion-icon>'
            : '<ion-icon class="msg-status" name="checkmark-outline"></ion-icon>';
    }

    _escape(str) {
        const el = document.createElement('div');

        el.textContent = str ?? '';

        return el.innerHTML;
    }
}