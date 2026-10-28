// domain/room.js
// A chat room as stored on this device. Name and secrets stay encrypted with the master key —
// only KeyStore decrypts the secrets (see docs/room-keys.md).

export class Room {
    // pending: join request sent, waiting for the approval · member · removed: not in the
    // member list anymore (left on another device or removed by a member)
    static STATUS_PENDING = "pending";
    static STATUS_MEMBER  = "member";
    static STATUS_REMOVED = "removed";

    constructor({ id, name, base, status, epoch, pushNotifications, store, ttl, messageTTL, lastRead, syncedUntil }) {
        this.id                = id;
        this.name              = name;              // encrypted with the master key
        this.base              = base;              // encrypted JSON {G, inviterId, identity, invites} — only KeyStore uses this
        this.status            = status ?? Room.STATUS_MEMBER;
        this.epoch             = epoch ?? 0;        // newest epoch this device knows
        this.pushNotifications = pushNotifications ?? false;
        this.store             = store ?? false;
        this.ttl               = ttl ?? 0;         // room maximum (seconds), fixed by the server
        this.messageTTL        = messageTTL ?? 0;  // TTL of own messages (seconds), 0 = room maximum — local only
        this.lastRead          = lastRead ?? 0;    // timestamp (ms) of the newest message seen in the room — local only
        // Server time (ms) up to which this device has every stored message of the room — the
        // next join asks for the messages from then on. Never the client clock.
        this.syncedUntil       = syncedUntil ?? 0;
    }

    // From a DB row — adapter decrypts name before calling this
    static fromDB(row) {
        return new Room({
            id:                row.id,
            name:              row.name,
            base:              row.base,
            status:            row.status,
            epoch:             row.epoch,
            pushNotifications: row.pushNotifications,
            store:             row.store,
            ttl:               row.ttl,
            messageTTL:        row.messageTTL,
            lastRead:          row.lastRead,
            syncedUntil:       row.syncedUntil,
        });
    }

    toJSON() {
        return {
            id:                this.id,
            name:              this.name,
            base:              this.base,
            status:            this.status,
            epoch:             this.epoch,
            pushNotifications: this.pushNotifications,
            store:             this.store,
            ttl:               this.ttl,
            messageTTL:        this.messageTTL,
            lastRead:          this.lastRead,
            syncedUntil:       this.syncedUntil,
        };
    }

    isPending() { return this.status === Room.STATUS_PENDING; }

    isMember()  { return this.status === Room.STATUS_MEMBER; }

    isRemoved() { return this.status === Room.STATUS_REMOVED; }
}
