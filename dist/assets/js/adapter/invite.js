// Room invite codes — the same string is shown as QR code and copied with "Copy Code".
//
// Format (kept short so the QR code stays coarse and easy to scan):
//   CB2-<base64url>    plain:  bytes = room id (16 byte UUID) | room key (32 byte) |
//                              length of the join code (1 byte) | join code (ASCII) | room name (UTF-8)
//   CB2P-<base64url>   PIN:    the plain code encrypted with AesAdapter.encryptByPIN
//   CB1-/CB1P-                 the same without join code (rooms that had no join secret yet, older codes)
//
// The join code (join_code.js) lets the server accept the join once and only for a few minutes.
//
// The code is plain text without a URL scheme, so the native iOS/Android camera only offers
// to copy it; it can then be pasted into the join dialog.
// Older invite codes (base64 JSON {v, enc, data} and the raw JSON {i, n, k} of old QR codes)
// are still accepted by decode().

const PREFIX_PLAIN = "CB2-";
const PREFIX_PIN = "CB2P-";
const PREFIX_PLAIN_V1 = "CB1-";
const PREFIX_PIN_V1 = "CB1P-";

const UUID_BYTES = 16;
const KEY_BYTES = 32;

export class InviteCode {
    constructor(aes) {
        this._aes = aes;
    }

    // invite: {i: roomId, n: roomName, k: base64 room key, c: join code (optional)}.
    // Returns the invite code string.
    async encode(invite, pin) {
        const name = new TextEncoder().encode(invite.n || "");
        const join = new TextEncoder().encode(invite.c || "");
        if (join.length > 255) throw new Error("join code too long");

        const head = UUID_BYTES + KEY_BYTES;
        const withCode = join.length > 0;
        const bytes = new Uint8Array(head + (withCode ? 1 + join.length : 0) + name.length);
        bytes.set(uuidToBytes(invite.i), 0);
        bytes.set(base64ToBytes(invite.k), UUID_BYTES);
        if (withCode) {
            bytes[head] = join.length;
            bytes.set(join, head + 1);
        }
        bytes.set(name, head + (withCode ? 1 + join.length : 0));

        const plain = (withCode ? PREFIX_PLAIN : PREFIX_PLAIN_V1) + bytesToBase64Url(bytes);
        if (!pin) return plain;

        const encrypted = await this._aes.encryptByPIN(plain, pin);
        return (withCode ? PREFIX_PIN : PREFIX_PIN_V1) + base64ToBase64Url(encrypted);
    }

    // True if decode() needs a PIN for this code.
    needsPin(code) {
        code = code.trim();
        if (code.startsWith(PREFIX_PIN) || code.startsWith(PREFIX_PIN_V1)) return true;
        const legacy = parseLegacy(code);
        return !!(legacy && legacy.enc);
    }

    // Returns {i, n, k, c}. Throws InviteError("pin") if a PIN is required or wrong,
    // InviteError("invalid") if the code cannot be read. c is empty for codes without join code.
    async decode(code, pin) {
        code = code.trim();

        const pinPrefix = [PREFIX_PIN, PREFIX_PIN_V1].find(p => code.startsWith(p));
        if (pinPrefix) {
            if (!pin) throw new InviteError("pin");
            let plain;
            try {
                plain = await this._aes.decryptByPIN(base64UrlToBase64(code.slice(pinPrefix.length)), pin);
            } catch {
                throw new InviteError("pin");
            }
            return this.decode(plain);
        }

        const plainPrefix = [PREFIX_PLAIN, PREFIX_PLAIN_V1].find(p => code.startsWith(p));
        if (plainPrefix) {
            let bytes;
            try {
                bytes = base64UrlToBytes(code.slice(plainPrefix.length));
            } catch {
                throw new InviteError("invalid");
            }

            const head = UUID_BYTES + KEY_BYTES;
            if (bytes.length < head) throw new InviteError("invalid");

            let c = "";
            let nameStart = head;
            if (plainPrefix === PREFIX_PLAIN) {
                const len = bytes[head];
                if (len === undefined || bytes.length < head + 1 + len) throw new InviteError("invalid");
                c = new TextDecoder().decode(bytes.subarray(head + 1, head + 1 + len));
                nameStart = head + 1 + len;
            }

            return {
                i: bytesToUuid(bytes.subarray(0, UUID_BYTES)),
                k: bytesToBase64(bytes.subarray(UUID_BYTES, head)),
                n: new TextDecoder().decode(bytes.subarray(nameStart)),
                c,
            };
        }

        // Old QR codes: raw JSON {i, n, k}
        if (code.startsWith("{")) {
            try {
                return checkInvite(JSON.parse(code));
            } catch {
                throw new InviteError("invalid");
            }
        }

        // Old copied codes: base64 of {v: 1, enc, data}
        const legacy = parseLegacy(code);
        if (!legacy) throw new InviteError("invalid");

        let data = legacy.data;
        if (legacy.enc) {
            if (!pin) throw new InviteError("pin");
            try {
                data = await this._aes.decryptByPIN(legacy.data, pin);
            } catch {
                throw new InviteError("pin");
            }
        }
        try {
            return checkInvite(JSON.parse(data));
        } catch {
            throw new InviteError("invalid");
        }
    }
}

// reason: "pin" (PIN missing or wrong) or "invalid"
export class InviteError extends Error {
    constructor(reason) {
        super(reason === "pin" ? "invite code needs a valid PIN" : "invalid invite code");
        this.reason = reason;
    }
}

function parseLegacy(code) {
    try {
        const bytes = Uint8Array.from(atob(code), c => c.charCodeAt(0));
        const obj = JSON.parse(new TextDecoder().decode(bytes));
        return obj && obj.v === 1 ? obj : null;
    } catch {
        return null;
    }
}

function checkInvite(obj) {
    if (!obj || typeof obj.i !== "string" || typeof obj.k !== "string") throw new Error("invalid invite");
    return { i: obj.i, n: obj.n || "", k: obj.k, c: "" };
}

// -------------------------------------------------------------------------
// Encoding helpers
// -------------------------------------------------------------------------

function uuidToBytes(uuid) {
    const hex = uuid.replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("room id is not a UUID: " + uuid);
    return Uint8Array.from(hex.match(/../g), h => parseInt(h, 16));
}

function bytesToUuid(bytes) {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
