// domain/room.js
// Represents a chat room — always holds decrypted name
// key stays encrypted (only KeyStore ever decrypts it)

export class Room {

    constructor({ id, name, key, joinSecret, pushNotifications, store, ttl, messageTTL, lastRead }) {
        this.id                = id;
        this.name              = name;              // decrypted
        this.key               = key;              // encrypted base64 — only KeyStore uses this
        this.joinSecret        = joinSecret;       // encrypted base64, from the server — only KeyStore uses this
        this.pushNotifications = pushNotifications ?? false;
        this.store             = store ?? false;
        this.ttl               = ttl ?? 0;         // room maximum (seconds), fixed by the server
        this.messageTTL        = messageTTL ?? 0;  // TTL of own messages (seconds), 0 = room maximum — local only
        this.lastRead          = lastRead ?? 0;    // timestamp (ms) of the newest message seen in the room — local only
    }

    // -------------------------------------------------------------------------
    // Factories — JSON → Room
    // -------------------------------------------------------------------------

    // From a DB row — adapter decrypts name before calling this
    static fromDB(row) {
        return new Room({
            id:                row.id,
            name:              row.name,
            key:               row.key,
            joinSecret:        row.joinSecret,
            pushNotifications: row.pushNotifications,
            store:             row.store,
            ttl:               row.ttl,
            messageTTL:        row.messageTTL,
            lastRead:          row.lastRead,
        });
    }

    // -------------------------------------------------------------------------
    // Serialization — Room → JSON (adapter encrypts name before storing)
    // -------------------------------------------------------------------------

    toJSON() {
        return {
            id:                 this.id,
            name:               this.name,
            key:                this.key,
            joinSecret:         this.joinSecret,
            pushNotifications: this.pushNotifications,
            store:              this.store,
            ttl:                this.ttl,
            messageTTL:         this.messageTTL,
            lastRead:           this.lastRead,
        };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
}
