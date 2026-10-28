// domain/file.js
// Represents a file/image that is transferred in chunks over the WebSocket.
// blob holds the (encrypted) file content; the matching Message references it by id.
// Encryption/decryption is handled by the adapter layer, not here

export class File {
    static TYPE_TEXT  = 0;
    static TYPE_IMAGE = 1;

    constructor({ id, roomId, blob, ttl, store,
                  mimeType, totalSize, chunkSize, chunksTotal }) {
        this.id          = id ?? crypto.randomUUID();
        this.roomId      = roomId;
        this.blob     = blob;
        this.mimeType    = mimeType;
        this.totalSize   = totalSize;
        this.chunkSize   = chunkSize;
        this.chunksTotal = chunksTotal;
        this.ttl         = ttl ?? 0;
        this.store       = store ?? false;
    }

    // -------------------------------------------------------------------------
    // Factories — JSON → File
    // -------------------------------------------------------------------------

    // From a decrypted DB row or decrypted WS payload
    // The adapter decrypts alias, alias_id and message before calling this
    static fromJSON(row) {
        return new File({
            // Required fields
            id:        row.id,
            roomId:    row.roomId,
            blob:       row.blob,
            mimeType:    row.mimeType,
            totalSize:   row.totalSize,
            chunkSize:   row.chunkSize,
            chunksTotal: row.chunksTotal,
            ttl:       row.ttl,
            store:     row.store,
        });
    }

    static fromDB(row) {
        return new File({
            // Required fields
            id:        row.id,
            roomId:    row.roomId,
            blob:       row.blob,
            mimeType:    row.mimeType,
            totalSize:   row.totalSize,
            chunkSize:   row.chunkSize,
            chunksTotal: row.chunksTotal,
            ttl:       row.ttl,
            store:     row.store,
        });
    }

    // -------------------------------------------------------------------------
    // Serialization — Message → JSON (adapter encrypts fields before storing/sending)
    // -------------------------------------------------------------------------

    toJSON() {
        return {
            id: this.id,
            roomId: this.roomId,
            blob: this.blob,
            mimeType: this.mimeType,
            totalSize: this.totalSize,
            chunkSize: this.chunkSize,
            chunksTotal: this.chunksTotal,
            ttl: this.ttl,
            store: this.store,
        };
    }
}

// Human readable size: "512 B", "1.4 MB"
export function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
