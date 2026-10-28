// domain/profile.js
// The local user profile (there is exactly one, id 0).
// salt + verify are used by KeyStore to check the password; clientId identifies this
// device on the WebSocket server.

export class Profile {

    constructor({id, uid, name, salt, verify, clientId}) {
        this.id = id ?? 0;
        this.uid = uid ?? crypto.randomUUID();
        this.name = name;
        this.salt = salt;
        this.verify = verify;
        this.clientId = clientId ?? crypto.randomUUID();
    }

    // -------------------------------------------------------------------------
    // Factories — DB row → Profile
    // -------------------------------------------------------------------------

    // From a DB row
    static fromDB(row) {
        return new Profile({
            id: row.id,
            uid: row.uid,
            name: row.name,
            salt: row.salt,
            verify: row.verify,
            clientId: row.clientId,
        });
    }

    // -------------------------------------------------------------------------
    // Serialization — Profile → DB row
    // -------------------------------------------------------------------------

    toDB() {
        return {
            id: this.id,
            uid: this.uid,
            name: this.name,
            salt: this.salt,
            verify: this.verify,
            clientId: this.clientId,
        };
    }

}
