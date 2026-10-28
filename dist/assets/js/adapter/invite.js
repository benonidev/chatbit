// Room invite codes — the same string is shown as QR code and copied with "Copy Code".
//
// Format (kept short so the QR code stays coarse and easy to scan, see docs/room-keys.md):
//   CB3-<base64url>    plain:  bytes = room id (16 byte UUID) | base key G (32 byte) |
//                              invite secret s (16 byte) | inviter member id (16 byte) |
//                              length of the invite code (1 byte) | invite code (ASCII) | room name (UTF-8)
//   CB3P-<base64url>   PIN:    the plain code encrypted with AesAdapter.encryptByPIN
//
// The invite code (join_code.js) lets the server accept the join request once and only for a
// few minutes. The code contains no room key: whoever has it can only ask to join — the inviter
// has to approve it. G must not pass through third parties (see docs/room-keys.md §12).
//
// The code is plain text without a URL scheme, so the native iOS/Android camera only offers
// to copy it; it can then be pasted into the join dialog. Codes of older versions (CB1, CB2,
// JSON) belong to rooms that do not exist anymore and are rejected with reason "old".

const PREFIX_PLAIN = "CB3-";
const PREFIX_PIN = "CB3P-";
const OLD_PREFIXES = ["CB2-", "CB2P-", "CB1-", "CB1P-", "{"];

const UUID_BYTES = 16;
const G_BYTES = 32;
const S_BYTES = 16;
const MEMBER_ID_BYTES = 16;
const HEAD = UUID_BYTES + G_BYTES + S_BYTES + MEMBER_ID_BYTES;

export class InviteCode {
    constructor(aes) {
        this._aes = aes;
    }

    // invite: {i: roomId, n: roomName, g: base64 G, s: base64 invite secret, m: inviter member id
    // (hex), c: invite code}. Returns the invite code string.
    async encode(invite, pin) {
        const name = new TextEncoder().encode(invite.n || "");
        const code = new TextEncoder().encode(invite.c || "");
        if (code.length > 255) throw new Error("invite code too long");

        const bytes = new Uint8Array(HEAD + 1 + code.length + name.length);
        bytes.set(uuidToBytes(invite.i), 0);
        bytes.set(base64ToBytes(invite.g), UUID_BYTES);
        bytes.set(base64ToBytes(invite.s), UUID_BYTES + G_BYTES);
        bytes.set(hexToBytes(invite.m), UUID_BYTES + G_BYTES + S_BYTES);
        bytes[HEAD] = code.length;
        bytes.set(code, HEAD + 1);
        bytes.set(name, HEAD + 1 + code.length);

        const plain = PREFIX_PLAIN + bytesToBase64Url(bytes);
        if (!pin) return plain;

        const encrypted = await this._aes.encryptByPIN(plain, pin);
        return PREFIX_PIN + base64ToBase64Url(encrypted);
    }

    // True if decode() needs a PIN for this code.
    needsPin(code) {
        return code.trim().startsWith(PREFIX_PIN);
    }

    // Returns {i, n, g, s, m, c}. Throws InviteError("pin") if a PIN is required or wrong,
    // InviteError("old") for codes of older versions, InviteError("invalid") otherwise.
    async decode(code, pin) {
        code = code.trim();

        if (code.startsWith(PREFIX_PIN)) {
            if (!pin) throw new InviteError("pin");
            let plain;
            try {
                plain = await this._aes.decryptByPIN(base64UrlToBase64(code.slice(PREFIX_PIN.length)), pin);
            } catch {
                throw new InviteError("pin");
            }
            return this.decode(plain);
        }

        if (!code.startsWith(PREFIX_PLAIN)) {
            throw new InviteError(OLD_PREFIXES.some(p => code.startsWith(p)) ? "old" : "invalid");
        }

        let bytes;
        try {
            bytes = base64UrlToBytes(code.slice(PREFIX_PLAIN.length));
        } catch {
            throw new InviteError("invalid");
        }

        const len = bytes[HEAD];
        if (len === undefined || bytes.length < HEAD + 1 + len) throw new InviteError("invalid");

        return {
            i: bytesToUuid(bytes.subarray(0, UUID_BYTES)),
            g: bytesToBase64(bytes.subarray(UUID_BYTES, UUID_BYTES + G_BYTES)),
            s: bytesToBase64(bytes.subarray(UUID_BYTES + G_BYTES, UUID_BYTES + G_BYTES + S_BYTES)),
            m: bytesToHex(bytes.subarray(UUID_BYTES + G_BYTES + S_BYTES, HEAD)),
            c: new TextDecoder().decode(bytes.subarray(HEAD + 1, HEAD + 1 + len)),
            n: new TextDecoder().decode(bytes.subarray(HEAD + 1 + len)),
        };
    }
}

// reason: "pin" (PIN missing or wrong), "old" (code of an older version) or "invalid"
export class InviteError extends Error {
    constructor(reason) {
        super({pin: "invite code needs a valid PIN", old: "invite code of an older version"}[reason] ?? "invalid invite code");
        this.reason = reason;
    }
}

// -------------------------------------------------------------------------
// Encoding helpers
// -------------------------------------------------------------------------

function uuidToBytes(uuid) {
    const hex = uuid.replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("room id is not a UUID: " + uuid);
    return hexToBytes(hex);
}

function bytesToUuid(bytes) {
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hexToBytes(hex) {
    return Uint8Array.from(hex.match(/../g), h => parseInt(h, 16));
}

function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
}

function base64ToBytes(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function base64ToBase64Url(b64) {
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBase64(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    return b64 + "=".repeat((4 - b64.length % 4) % 4);
}

function bytesToBase64Url(bytes) {
    return base64ToBase64Url(bytesToBase64(bytes));
}

function base64UrlToBytes(b64url) {
    return base64ToBytes(base64UrlToBase64(b64url));
}
