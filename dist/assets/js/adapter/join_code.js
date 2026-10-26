// Join codes prove to the server that a client may join a room — same derivation as the server
// (internal/domain/joincode.go): HMAC-SHA256 with the join secret of the room, first 9 bytes,
// base64url, over a 5 minute time window and a random nonce. Every code is valid once.
//
//   invite code: "<nonce>.<HMAC(secret, "invite:<window>:<nonce>")>" — in the invite QR code
//   member code: "<nonce>.<HMAC(secret, "member:<window>:<clientUid>:<nonce>")>" — a new one
//                with every join, only valid for this client
//
// The server also accepts the window before and after the current one (clocks that are off).

export const JOIN_CODE_PERIOD = 300; // seconds per window
const JOIN_CODE_BYTES = 9;
const NONCE_BYTES = 6;

export function joinWindow(now = Date.now()) {
    return Math.floor(now / 1000 / JOIN_CODE_PERIOD);
}

// Time (ms) after which the server no longer accepts a code of the window
export function joinWindowEnd(window) {
    return (window + 2) * JOIN_CODE_PERIOD * 1000;
}

// The join secret comes base64 encoded with room_info
export async function importJoinSecret(secretBase64) {
    const raw = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
}

export async function inviteCode(key, window, nonce = randomNonce()) {
    return nonce + "." + await joinCode(key, `invite:${window}:${nonce}`);
}

export async function memberCode(key, window, clientUid, nonce = randomNonce()) {
    return nonce + "." + await joinCode(key, `member:${window}:${clientUid}:${nonce}`);
}

async function joinCode(key, msg) {
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
    return toBase64Url(new Uint8Array(mac).subarray(0, JOIN_CODE_BYTES));
}

function randomNonce() {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function toBase64Url(bytes) {
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
