// adapter/aes.js
// Responsible for: all encryption/decryption logic + in-memory key cache

export class AesAdapter {

    // -------------------------------------------------------------------------
    // Key Generation & Derivation
    // -------------------------------------------------------------------------

    // Generate a new key — extractable so it can be exported to base64 for DB storage
    async generateKey() {
        return await crypto.subtle.generateKey(
            {name: 'AES-GCM', length: 256},
            true,
            ['encrypt', 'decrypt']
        );
    }

    // Derive DB key from password + salt — non-extractable, stays in crypto engine
    async deriveKey(password, salt) {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            {name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256'},
            keyMaterial,
            {name: 'AES-GCM', length: 256},
            false,  // non-extractable — key can never be read as raw bytes
            ['encrypt', 'decrypt']
        );
    }

    // -------------------------------------------------------------------------
    // Encrypt / Decrypt
    // -------------------------------------------------------------------------

    async encrypt(data, key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            {name: 'AES-GCM', iv},
            key,
            new TextEncoder().encode(data)
        );
        const buf = new Uint8Array(iv.byteLength + encrypted.byteLength);
        buf.set(iv, 0);
        buf.set(new Uint8Array(encrypted), iv.byteLength);
        return this._bufToBase64(buf);
    }

    // Like encrypt(), but the text is padded to a size class first (see padText), so the
    // ciphertext length does not reveal the length of a message or alias.
    async encryptPadded(text, key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, padText(text));
        const buf = new Uint8Array(iv.byteLength + encrypted.byteLength);
        buf.set(iv, 0);
        buf.set(new Uint8Array(encrypted), iv.byteLength);
        return this._bufToBase64(buf);
    }

    // Decrypts encrypt() and encryptPadded() data
    async decrypt(encryptedData, key) {
        const buf = this._base64ToBuf(encryptedData);
        const iv = buf.slice(0, 12);
        const data = buf.slice(12);
        const decrypted = await crypto.subtle.decrypt(
            {name: 'AES-GCM', iv},
            key,
            data
        );
        return unpadText(new Uint8Array(decrypted));
    }

    // The file is padded (see padFile) and its MIME type is stored inside the encrypted data,
    // so the server learns neither the exact size nor the image format.
    async encryptFile(fileOrBlob, key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const buf = padFile(new Uint8Array(await fileOrBlob.arrayBuffer()), fileOrBlob.type);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            await key,
            buf
        );

        const result = new Uint8Array(12 + encrypted.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encrypted), 12);
        return result.buffer; // ArrayBuffer — no Base64 overhead
    }

    async decryptFile(encryptedBuffer, mimeType, key) {
        return URL.createObjectURL(await this.decryptFileBlob(encryptedBuffer, mimeType, key));
    }

    async decryptFileBlob(encryptedBuffer, mimeType, key) {
        const data = new Uint8Array(encryptedBuffer);
        const iv = data.slice(0, 12);
        const payload = data.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            await key,
            payload
        );

        // Padded files carry their own MIME type, older ones use the one from the header
        const file = unpadFile(new Uint8Array(decrypted));
        if (file) return new Blob([file.data], { type: file.mimeType });
        return new Blob([decrypted], { type: mimeType });
    }

    // -------------------------------------------------------------------------
    // Encrypt / Decrypt by PIN
    // -------------------------------------------------------------------------

    async encryptByPIN(data, pin) {
        const salt = await crypto.getRandomValues(new Uint8Array(16));
        const key = await this.deriveKey(pin, salt)

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            {name: 'AES-GCM', iv},
            key,
            new TextEncoder().encode(data)
        );
        const buf = new Uint8Array(salt.byteLength + iv.byteLength + encrypted.byteLength);
        buf.set(salt, 0);
        buf.set(iv, salt.byteLength);
        buf.set(new Uint8Array(encrypted), salt.byteLength + iv.byteLength);
        return this._bufToBase64(buf);
    }

    async decryptByPIN(encryptedData, pin) {
        const buf = this._base64ToBuf(encryptedData);
        const salt = buf.slice(0, 16);
        const iv = buf.slice(16, 28);
        const data = buf.slice(28);

        const key = await this.deriveKey(pin, salt)

        const decrypted = await crypto.subtle.decrypt(
            {name: 'AES-GCM', iv},
            key,
            data
        );
        return new TextDecoder().decode(decrypted);
    }

    // -------------------------------------------------------------------------
    // Convert Key
    // -------------------------------------------------------------------------

    // Import a base64 key string as a extractable CryptoKey
    async importKey(base64) {
        const bytes = this._base64ToBuffer(base64);
        return crypto.subtle.importKey(
            'raw', bytes, 'AES-GCM',
            true,  // extractable
            ['encrypt', 'decrypt']
        );
    }

    // Export to a base64 key string as a non-extractable CryptoKey
    async exportKey(key) {
        const exported = await crypto.subtle.exportKey('raw', key);
        return btoa(String.fromCharCode(...new Uint8Array(exported)));
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    _bufToBase64(buf) {
        return btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''));
    }

    _base64ToBuf(b64) {
        return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    }

    _base64ToBuffer(base64) {
        const s = atob(base64);
        const bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
        return bytes.buffer;
    }
}

// -------------------------------------------------------------------------
// Padding — hides the length of messages and files from the server
// -------------------------------------------------------------------------
//
// Text:  0x00 'P' | length (uint32) | UTF-8 | zeros    — size classes 256 B, 1 KB, 4 KB, 16 KB, then Padmé
// File:  0x00 'P' 'F' | MIME length (uint8) | MIME | length (uint32) | data | zeros   — Padmé, min. 16 KB
//
// The leading 0x00 'P' can't be the start of an older, unpadded text or image (text never starts
// with a NUL byte; JPEG, PNG, GIF, WebP and HEIC have other magic bytes), so old data still decrypts.

const TEXT_MAGIC = [0x00, 0x50];        // "\0P"
const FILE_MAGIC = [0x00, 0x50, 0x46];  // "\0PF"
const TEXT_CLASSES = [256, 1024, 4096, 16384];
const FILE_MIN_SIZE = 16 * 1024;

// Padmé (Nikitin et al., 2019): rounds L up so that only O(log log L) bits of the length are
// left; the overhead is at most ~12 %.
export function padme(length) {
    if (length < 2) return length;
    const e = Math.floor(Math.log2(length));
    const s = Math.floor(Math.log2(e)) + 1;
    const step = 2 ** (e - s);
    return Math.ceil(length / step) * step;
}

function textSizeClass(length) {
    return TEXT_CLASSES.find(c => length <= c) ?? padme(length);
}

export function padText(text) {
    const data = new TextEncoder().encode(text);
    const header = TEXT_MAGIC.length + 4;
    const out = new Uint8Array(textSizeClass(header + data.length));
    out.set(TEXT_MAGIC, 0);
    new DataView(out.buffer).setUint32(TEXT_MAGIC.length, data.length);
    out.set(data, header);
    return out;
}

export function unpadText(bytes) {
    if (!startsWith(bytes, TEXT_MAGIC)) return new TextDecoder().decode(bytes); // not padded (older data)
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(TEXT_MAGIC.length);
    const header = TEXT_MAGIC.length + 4;
    return new TextDecoder().decode(bytes.subarray(header, header + length));
}

export function padFile(data, mimeType) {
    const mime = new TextEncoder().encode((mimeType || "application/octet-stream").slice(0, 255));
    const header = FILE_MAGIC.length + 1 + mime.length + 4;
    const out = new Uint8Array(Math.max(FILE_MIN_SIZE, padme(header + data.length)));
    out.set(FILE_MAGIC, 0);
    out[FILE_MAGIC.length] = mime.length;
    out.set(mime, FILE_MAGIC.length + 1);
    new DataView(out.buffer).setUint32(FILE_MAGIC.length + 1 + mime.length, data.length);
    out.set(data, header);
    return out;
}

// Returns {mimeType, data} or null for older, unpadded files
export function unpadFile(bytes) {
    if (!startsWith(bytes, FILE_MAGIC)) return null;
    const mimeLength = bytes[FILE_MAGIC.length];
    const mimeStart = FILE_MAGIC.length + 1;
    const mimeType = new TextDecoder().decode(bytes.subarray(mimeStart, mimeStart + mimeLength));
    const lengthAt = mimeStart + mimeLength;
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(lengthAt);
    return {mimeType, data: bytes.subarray(lengthAt + 4, lengthAt + 4 + length)};
}

function startsWith(bytes, magic) {
    return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}
