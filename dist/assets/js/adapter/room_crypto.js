// Room keys with epochs — all cryptography of docs/room-keys.md, without DOM or database, so it
// runs in the browser and in Node (tests/js).
//
//   G    base key, from the invite QR code, never sent to the server
//   K, J epoch key and join secret, 32 random bytes each, sent in the envelopes of a rotation
//   R    room key of an epoch = HKDF(K, salt G) → message, file and roster keys
//
// Every member has two key pairs per room: Ed25519 (identity, signs) and X25519 (receives
// envelopes, HPKE RFC 9180). The member id is the first 16 bytes of SHA-256(Ed25519 public key).
//
// Byte strings are passed around as Uint8Array; on the wire and in the database they are base64.
import {Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, ed25519, sha256 as nobleSha256} from "../lib/crypto-bundle.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const hpke = new CipherSuite({kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm()});

export const KEY_BYTES = 32;
const MEMBER_ID_BYTES = 16;
const BODY_BLOCK = 2048; // rotation bodies are padded to a multiple of this — the size hints less at the member count

// Domain separation: every signature, MAC and derivation has its own label
const LABEL = {
    room: "chatbit/v2/room",
    message: "chatbit/v2/message",
    file: "chatbit/v2/file",
    roster: "chatbit/v2/roster",
    wrap: "chatbit/v2/wrap",
    request: "chatbit/v2/request",
    envelope: "chatbit/v2/envelope",
    rotation: "chatbit/v2/rotation",
    joinMac: "chatbit/v2/join-mac",
    joinSig: "chatbit/v2/join-request",
    keyUpdate: "chatbit/v2/key-update",
    messageSig: "chatbit/v2/message-sig",
    alias: "chatbit/v2/alias",
};

export const MAX_ALIAS = 64;

export class RoomCryptoError extends Error {
    constructor(reason) {
        super("room crypto: " + reason);
        this.reason = reason;
    }
}

// -------------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------------

// New key pairs for one room. All fields are base64 — stored encrypted with the master key.
export async function newIdentity() {
    const edSecret = ed25519.utils.randomSecretKey();
    const identity = {
        edSecret: b64(edSecret),
        ed: b64(ed25519.getPublicKey(edSecret)),
    };
    identity.memberId = memberIdOf(identity.ed);
    return {...identity, ...await newExchangeKey()};
}

// New X25519 key pair (renewal): {xSeed, x, xDate}. The private key is derived from the seed.
export async function newExchangeKey() {
    const seed = random(KEY_BYTES);
    return {xSeed: b64(seed), x: b64(await x25519Public(seed)), xDate: Date.now()};
}

export function memberIdOf(edBase64) {
    return hex(sha256Sync(unb64(edBase64)).subarray(0, MEMBER_ID_BYTES));
}

// "7F3A 19C2 0B5E 44D1" — the first 8 bytes of the member id, for comparing in person
export function fingerprint(memberId) {
    return memberId.slice(0, 16).toUpperCase().match(/.{4}/g).join(" ");
}

// The roster entry of an identity. The alias is fixed for the room: the member signs it itself
// (aliasSig), so whoever writes a roster can not rename it — see checkRosterAliases.
export function rosterEntry(roomId, identity, alias) {
    alias = String(alias ?? "").slice(0, MAX_ALIAS);
    return {memberId: identity.memberId, ed: identity.ed, x: identity.x, xDate: identity.xDate, alias, aliasSig: signAlias(roomId, identity, alias)};
}

export function signAlias(roomId, identity, alias) {
    return b64(ed25519.sign(aliasBytes(roomId, alias), unb64(identity.edSecret)));
}

function aliasBytes(roomId, alias) {
    return fields(utf8(LABEL.alias), uuidBytes(roomId), utf8(alias));
}

function aliasValid(roomId, m) {
    try {
        return typeof m.alias === "string" && m.alias.length <= MAX_ALIAS
            && ed25519.verify(unb64(m.aliasSig), aliasBytes(roomId, m.alias), unb64(m.ed));
    } catch {
        return false;
    }
}

// Aliases of a roster: a member that was in the previous roster keeps its alias, every other one
// must have signed its alias itself. Entries without aliasSig (rooms from before) are only
// accepted unchanged from the previous roster, or without one (a new member trusts its inviter).
function checkRosterAliases(roomId, roster, prevRoster) {
    for (const m of roster) {
        const before = prevRoster?.find(p => p.memberId === m.memberId);
        if (before && before.alias !== m.alias) throw new RoomCryptoError("alias");
        if (m.aliasSig === undefined && (before || !prevRoster)) continue;
        if (!aliasValid(roomId, m)) throw new RoomCryptoError("alias");
    }
}

// -------------------------------------------------------------------------
// Keys of a room and of an epoch
// -------------------------------------------------------------------------

export function newRoomSecret() {
    return b64(random(KEY_BYTES));
}

// Keys derived from G only: wrapKey (rotation bodies) and requestKey (join requests)
export async function baseKeys(roomId, G) {
    const g = unb64(G);
    const room = uuidBytes(roomId);
    return {
        wrapKey: await aesKey(await hkdf(g, new Uint8Array(0), concat(utf8(LABEL.wrap), room))),
        requestKey: await aesKey(await hkdf(g, new Uint8Array(0), concat(utf8(LABEL.request), room))),
    };
}

// All keys of one epoch. K and G are base64.
export async function epochKeys(roomId, epoch, K, G) {
    const R = await hkdf(unb64(K), unb64(G), concat(utf8(LABEL.room), uuidBytes(roomId), u32(epoch)));
    return {
        messageKey: await aesKey(await hkdf(R, new Uint8Array(0), utf8(LABEL.message))),
        fileKey: await aesKey(await hkdf(R, new Uint8Array(0), utf8(LABEL.file))),
        rosterKey: await aesKey(await hkdf(R, new Uint8Array(0), utf8(LABEL.roster))),
    };
}

// -------------------------------------------------------------------------
// Rotation
// -------------------------------------------------------------------------

// Builds the rotation to epoch `epoch` for every member of `roster`.
//   prevHash: hash of the previous rotation's header (base64), null for epoch 1
//   reason:   "create" | "add" | "leave" | "remove" | "renew"; subject: member id it is about
// Returns {body, joinSecret, K, J, headerHash} — body and joinSecret go to the server.
export async function buildRotation({roomId, G, epoch, prevHash, identity, roster, reason, subject}) {
    const K = random(KEY_BYTES);
    const J = random(KEY_BYTES);
    const sorted = [...roster].sort((a, b) => a.memberId.localeCompare(b.memberId));
    const rosterBytes = utf8(JSON.stringify(sorted));
    const {rosterKey} = await epochKeys(roomId, epoch, b64(K), G);

    const envelopes = {};
    for (const member of sorted) {
        envelopes[member.memberId] = b64(await sealEnvelope(roomId, epoch, member, concat(K, J)));
    }

    const header = JSON.stringify({
        v: 2,
        roomId,
        epoch,
        prevHash: prevHash ?? b64(new Uint8Array(32)),
        signerId: identity.memberId,
        members: sorted.map(m => m.memberId),
        rosterHash: b64(await sha256(rosterBytes)),
        envelopesHash: b64(await envelopesHash(envelopes)),
        reason,
        subject: subject ?? null,
        created: Date.now(),
    });
    const sig = ed25519.sign(concat(utf8(LABEL.rotation), utf8(header)), unb64(identity.edSecret));

    const plain = utf8(JSON.stringify({
        header,
        sig: b64(sig),
        envelopes,
        roster: b64(await aesEncrypt(rosterKey, rosterBytes, rotationAad(roomId, epoch))),
    }));
    const {wrapKey} = await baseKeys(roomId, G);

    return {
        body: b64(await aesEncrypt(wrapKey, padBlock(plain), rotationAad(roomId, epoch))),
        joinSecret: b64(J),
        K: b64(K),
        J: b64(J),
        headerHash: b64(await sha256(utf8(header))),
        roster: sorted,
    };
}

// Checks and opens a rotation. Throws RoomCryptoError if it is not valid.
//   expectedEpoch: the epoch the client expects (its own + 1)
//   prev:          {headerHash, roster} of the epoch before, or null if the client has none yet
//                  (a new member: then the signer must be `inviterId`, from the QR code)
//   identity:      own identity (memberId, xSeed and the previous xSeed after a renewal)
// Returns {epoch, header, headerHash, roster, member, K, J} — member is false (and K, J null)
// if the rotation has no envelope for this client (removed, or not approved yet).
export async function openRotation({roomId, G, body, expectedEpoch, prev, inviterId, identity}) {
    const {wrapKey} = await baseKeys(roomId, G);

    let content;
    try {
        content = JSON.parse(dec.decode(unpadBlock(await aesDecrypt(wrapKey, unb64(body), rotationAad(roomId, expectedEpoch)))));
    } catch {
        throw new RoomCryptoError("body");
    }

    const headerBytes = utf8(content.header);
    const header = JSON.parse(content.header);
    if (header.v !== 2 || header.roomId !== roomId || header.epoch !== expectedEpoch) {
        throw new RoomCryptoError("header");
    }
    if (prev && header.prevHash !== prev.headerHash) throw new RoomCryptoError("chain");
    if (!prev && expectedEpoch === 1 && header.prevHash !== b64(new Uint8Array(32))) throw new RoomCryptoError("chain");

    // Who may sign: a member of the previous epoch — or, without one, the inviter of a new member
    // (from the QR code) or the client itself for the first epoch of its own room
    let signer;
    if (prev) {
        signer = prev.roster.find(m => m.memberId === header.signerId);
    } else {
        const allowed = inviterId ?? (expectedEpoch === 1 ? identity.memberId : null);
        if (!allowed || header.signerId !== allowed) throw new RoomCryptoError("signer");
    }

    if (header.envelopesHash !== b64(await envelopesHash(content.envelopes))) throw new RoomCryptoError("envelopes");

    // Own envelope — sealed for the current or (after a renewal) the previous exchange key
    let secret = null;
    const envelope = content.envelopes[identity.memberId];
    if (envelope) {
        for (const seed of [identity.xSeed, identity.xSeedPrevious].filter(Boolean)) {
            try {
                secret = await openEnvelope(roomId, expectedEpoch, identity.memberId, seed, unb64(envelope));
                break;
            } catch { /* try the previous key */ }
        }
        if (!secret) throw new RoomCryptoError("envelope");
    }

    // Without an envelope only the header can be checked. A member must still see a valid
    // signature — otherwise anyone with G could make it believe it was removed. A waiting new
    // member can not check it (it does not know the keys yet) and only learns "not for me yet".
    if (!secret) {
        if (prev) verifyRotationSig(signer, headerBytes, content.sig);
        return {epoch: header.epoch, header, headerHash: b64(await sha256(headerBytes)), member: false, verified: !!prev, K: null, J: null, roster: null};
    }

    const K = b64(secret.subarray(0, KEY_BYTES));
    const J = b64(secret.subarray(KEY_BYTES, 2 * KEY_BYTES));
    const {rosterKey} = await epochKeys(roomId, expectedEpoch, K, G);

    let rosterBytes;
    try {
        rosterBytes = await aesDecrypt(rosterKey, unb64(content.roster), rotationAad(roomId, expectedEpoch));
    } catch {
        throw new RoomCryptoError("roster");
    }
    if (header.rosterHash !== b64(await sha256(rosterBytes))) throw new RoomCryptoError("roster");

    const roster = JSON.parse(dec.decode(rosterBytes));
    const ids = roster.map(m => m.memberId);
    if (ids.length !== header.members.length || ids.some((id, i) => id !== header.members[i])) {
        throw new RoomCryptoError("roster");
    }
    for (const m of roster) {
        if (memberIdOf(m.ed) !== m.memberId) throw new RoomCryptoError("roster");
    }
    checkRosterAliases(roomId, roster, prev?.roster ?? null);

    // With a previous epoch the signer must come from its roster — never from the new one, or
    // anyone who knows G could add itself and sign. Without one (new member, own first epoch) the
    // signer's key is taken from the new roster: its member id is the hash of that key and was
    // checked against the inviter id / own id above.
    if (!prev) signer = roster.find(m => m.memberId === header.signerId);
    if (!signer) throw new RoomCryptoError("signature");
    verifyRotationSig(signer, headerBytes, content.sig);

    return {epoch: header.epoch, header, headerHash: b64(await sha256(headerBytes)), member: true, K, J, roster};
}

function verifyRotationSig(signer, headerBytes, sig) {
    if (!signer || !ed25519.verify(unb64(sig), concat(utf8(LABEL.rotation), headerBytes), unb64(signer.ed))) {
        throw new RoomCryptoError("signature");
    }
}

async function sealEnvelope(roomId, epoch, member, secret) {
    const context = concat(utf8(LABEL.envelope), uuidBytes(roomId), u32(epoch), utf8(member.memberId));
    const recipientPublicKey = await hpke.kem.deserializePublicKey(toBuffer(unb64(member.x)));
    const {enc: encapsulated, ct} = await hpke.seal({recipientPublicKey, info: toBuffer(context)}, toBuffer(secret), toBuffer(context));
    return concat(new Uint8Array(encapsulated), new Uint8Array(ct));
}

async function openEnvelope(roomId, epoch, memberId, xSeed, sealed) {
    const context = concat(utf8(LABEL.envelope), uuidBytes(roomId), u32(epoch), utf8(memberId));
    const {privateKey} = await hpke.kem.deriveKeyPair(toBuffer(unb64(xSeed)));
    const pt = await hpke.open({recipientKey: privateKey, enc: toBuffer(sealed.subarray(0, 32)), info: toBuffer(context)},
        toBuffer(sealed.subarray(32)), toBuffer(context));
    return new Uint8Array(pt);
}

async function envelopesHash(envelopes) {
    const parts = Object.keys(envelopes).sort().flatMap(id => [utf8(id), unb64(envelopes[id])]);
    return sha256(fields(...parts));
}

function rotationAad(roomId, epoch) {
    return concat(utf8(LABEL.rotation), uuidBytes(roomId), u32(epoch));
}

// -------------------------------------------------------------------------
// Join request
// -------------------------------------------------------------------------

// The request of a new member: its public keys and alias (at most MAX_ALIAS characters, fixed for
// the room), encrypted with G. The MAC with the
// invite secret s proves to the inviter that the keys come from whoever scanned its QR code.
export async function buildJoinRequest({roomId, G, s, identity, alias, inviterId}) {
    alias = String(alias ?? "").slice(0, MAX_ALIAS);
    const keys = joinKeys(roomId, identity.ed, identity.x);
    const mac = await hmac(unb64(s), concat(utf8(LABEL.joinMac), keys));
    const sig = ed25519.sign(concat(utf8(LABEL.joinSig), keys, utf8(alias), utf8(inviterId)), unb64(identity.edSecret));

    const plain = utf8(JSON.stringify({ed: identity.ed, x: identity.x, xDate: identity.xDate, alias, aliasSig: signAlias(roomId, identity, alias),
        inviterId, mac: b64(mac), sig: b64(sig)}));
    const {requestKey} = await baseKeys(roomId, G);
    return b64(await aesEncrypt(requestKey, plain, concat(utf8(LABEL.request), uuidBytes(roomId))));
}

// Opens a join request. `s` is only known to the inviter: with it, macOk tells whether the keys
// are the ones of the person with the QR code. Throws RoomCryptoError if it is not valid at all.
export async function openJoinRequest({roomId, G, request, s}) {
    const {requestKey} = await baseKeys(roomId, G);
    let req;
    try {
        req = JSON.parse(dec.decode(await aesDecrypt(requestKey, unb64(request), concat(utf8(LABEL.request), uuidBytes(roomId)))));
    } catch {
        throw new RoomCryptoError("request");
    }

    const keys = joinKeys(roomId, req.ed, req.x);
    const signed = concat(utf8(LABEL.joinSig), keys, utf8(req.alias ?? ""), utf8(req.inviterId ?? ""));
    if (!ed25519.verify(unb64(req.sig), signed, unb64(req.ed))) throw new RoomCryptoError("signature");

    let macOk = false;
    if (s) {
        const expected = await hmac(unb64(s), concat(utf8(LABEL.joinMac), keys));
        macOk = equal(expected, unb64(req.mac));
    }

    const entry = {memberId: memberIdOf(req.ed), ed: req.ed, x: req.x, xDate: req.xDate ?? 0, alias: req.alias, aliasSig: req.aliasSig};
    if (!aliasValid(roomId, entry)) throw new RoomCryptoError("alias");

    return {
        entry,
        inviterId: req.inviterId,
        macOk,
    };
}

function joinKeys(roomId, ed, x) {
    return fields(uuidBytes(roomId), unb64(ed), unb64(x));
}

// -------------------------------------------------------------------------
// Key update (new X25519 key between two rotations)
// -------------------------------------------------------------------------

export async function buildKeyUpdate({roomId, epoch, keys, identity}) {
    const signed = fields(utf8(LABEL.keyUpdate), uuidBytes(roomId), u32(epoch), utf8(identity.memberId), unb64(identity.x), utf8(String(identity.xDate)));
    const plain = utf8(JSON.stringify({memberId: identity.memberId, x: identity.x, xDate: identity.xDate,
        sig: b64(ed25519.sign(signed, unb64(identity.edSecret)))}));
    return b64(await aesEncrypt(keys.rosterKey, plain, concat(utf8(LABEL.keyUpdate), u32(epoch))));
}

// Returns {memberId, x, xDate} if the update is signed by that member of `roster`, otherwise throws
export async function openKeyUpdate({roomId, epoch, keys, update, roster}) {
    let u;
    try {
        u = JSON.parse(dec.decode(await aesDecrypt(keys.rosterKey, unb64(update), concat(utf8(LABEL.keyUpdate), u32(epoch)))));
    } catch {
        throw new RoomCryptoError("update");
    }
    const member = roster.find(m => m.memberId === u.memberId);
    const signed = fields(utf8(LABEL.keyUpdate), uuidBytes(roomId), u32(epoch), utf8(u.memberId), unb64(u.x), utf8(String(u.xDate)));
    if (!member || !ed25519.verify(unb64(u.sig), signed, unb64(member.ed))) throw new RoomCryptoError("signature");
    return {memberId: u.memberId, x: u.x, xDate: u.xDate};
}

// -------------------------------------------------------------------------
// Message signatures
// -------------------------------------------------------------------------

// Signature over everything that identifies a message, its plaintext content and the message it
// answers (replyTo — nobody can move a reply under another message). The sender is
// not in it: the member id in the message selects the key the signature is checked with. `alias`
// is only set for messages from before the alias moved into the roster (it was signed then).
export function signMessage(identity, m) {
    return b64(ed25519.sign(messageBytes(m), unb64(identity.edSecret)));
}

export function verifyMessage(edBase64, m, sig) {
    try {
        return ed25519.verify(unb64(sig), messageBytes(m), unb64(edBase64));
    } catch {
        return false;
    }
}

// replyTo (id of the message answered) is only appended when set, so messages without one keep
// the encoding they always had
function messageBytes({roomId, epoch, id, type, alias, content, replyTo}) {
    const parts = [utf8(LABEL.messageSig), uuidBytes(roomId), u32(epoch), utf8(id), u32(type), utf8(alias ?? ""), utf8(content ?? "")];
    if (replyTo) parts.push(utf8(replyTo));
    return fields(...parts);
}

// -------------------------------------------------------------------------
// Primitives
// -------------------------------------------------------------------------

export async function aesEncrypt(key, plain, aad) {
    const iv = random(12);
    const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: aad}, key, plain);
    return concat(iv, new Uint8Array(ct));
}

export async function aesDecrypt(key, data, aad) {
    const pt = await crypto.subtle.decrypt({name: "AES-GCM", iv: data.subarray(0, 12), additionalData: aad}, key, data.subarray(12));
    return new Uint8Array(pt);
}

async function x25519Public(seed) {
    const {publicKey} = await hpke.kem.deriveKeyPair(toBuffer(seed));
    return new Uint8Array(await hpke.kem.serializePublicKey(publicKey));
}

async function hkdf(ikm, salt, info) {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, 256));
}

function aesKey(raw) {
    return crypto.subtle.importKey("raw", raw, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]);
}

async function hmac(keyBytes, data) {
    const key = await crypto.subtle.importKey("raw", keyBytes, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// Synchronous SHA-256 for member ids (WebCrypto is async only)
function sha256Sync(data) {
    return nobleSha256(data);
}

function random(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}

// Length-prefixed concatenation (u32 length ‖ bytes per field): no two field lists give the same bytes
function fields(...parts) {
    return concat(...parts.flatMap(p => [u32(p.length), p]));
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
}

function utf8(s) {
    return enc.encode(s);
}

function equal(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
}

// Pads to a multiple of BODY_BLOCK: u32 length ‖ data ‖ zeros
function padBlock(data) {
    const out = new Uint8Array(Math.ceil((data.length + 4) / BODY_BLOCK) * BODY_BLOCK);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(data, 4);
    return out;
}

function unpadBlock(data) {
    const length = new DataView(data.buffer, data.byteOffset).getUint32(0);
    return data.subarray(4, 4 + length);
}

// Copy into an exact ArrayBuffer (hpke-js wants ArrayBuffers, not views)
function toBuffer(bytes) {
    return bytes.slice().buffer;
}

export function uuidBytes(uuid) {
    const h = uuid.replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(h)) throw new RoomCryptoError("room id");
    return Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
}

export function hex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function b64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function unb64(s) {
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
