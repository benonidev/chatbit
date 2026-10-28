import {Events} from "./event.js";
import {Pages} from "./page.js";
import {Message} from "../domain/message.js";
import {File, formatBytes} from "../domain/file.js";
import {Modals} from "./modal.js";
import {InviteCode} from "./invite.js";
import {formatDuration, formatTTL, MESSAGE_TTL_STEPS, snapTTL} from "./expiry.js";
import {idHue} from "./color.js";
import {b64, fingerprint} from "./room_crypto.js";
import {Notifications} from "./notification.js";
import {logger} from "./log.js";

const log = logger("room");

const CHUNK_SIZE = 64 * 1024; // 64KB

// Chat room page: renders messages, encrypts and sends text and images, loads images on demand
// and handles the room actions (share, members, edit, clean, leave). Every message is encrypted
// with the keys of its epoch and signed by its sender (RoomKeys, docs/room-keys.md).
export class ViewRoom {
    constructor(events, aes, keyStore, db, roomKeys) {
        this._events = events;
        this._aes   = aes;
        this._db   = db;
        this._keyStore = keyStore;
        this._roomKeys = roomKeys;
        this._invite = new InviteCode(aes);

        this._roomId = null;
        this._room = null;        // the open Room (status, epoch)
        this._roomTimestamp = null;
        this._roomTTL = null;     // maximum TTL of the room (seconds), fixed when the room was created
        this._sendTTL = 0;        // TTL of own messages (edit dialog "Delete after"), 0 = room TTL
        this._roomName = null;
        this._roomStore = null;
        this._onRoomPage = false; // messages are only marked as read while the room is visible
        this._messageLoad = 0;    // incremented per message load of the room page
        this._shareFile = null; // image of the image modal, prepared for CHAT.SHARE_IMAGE
        this._share = null;     // share dialog: {code, expires, render} of the shown invite code
        this._shareUrl = null;
        this._roomNotification = null;
        this._replyTo = null;   // id of the message the next text answers (reply bar)

    }

    async init() {
        this._events.on(Events.WS.RECEIVED_MESSAGE, async (msg) => {
            if (!msg.isRoom(this._roomId) || !msg.isVisible()) return;

            // The echo of an own message only updates its status
            if (document.getElementById(msg.id)) {
                this._updateStatusHTML(msg);
                this._markRead(msg.timestamp); // the server timestamp may be newer than the local one
            } else {
                await this._newMessage(msg);
            }

            this._scrollToBottom();
        });

        // "Alice added Dave" — written by RoomKeys
        this._events.on(Events.CHAT.SYSTEM_MESSAGE, async (msg) => {
            if (!msg.isRoom(this._roomId) || !this._onRoomPage) return;
            await this._newMessage(msg);
            this._scrollToBottom();
        });

        // New epoch or status of the open room: messages of the new epoch can be read now
        const refresh = async (roomId) => {
            if (roomId !== this._roomId || !this._onRoomPage) return;
            this._room = await this._db.getRoom(roomId);
            if (!this._room) {
                this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
                return;
            }
            this._renderRoomState();
            this._renderRoomInfo();
            this._cleanActiveRoom();
            if (await this._getLatestMessages()) this._scrollToBottom();
        };
        this._events.on(Events.ROOM.ROTATED, ({roomId}) => refresh(roomId));
        this._events.on(Events.ROOM.CHANGED, (roomId) => refresh(roomId));

        this._events.on(Events.ROOM.SHOW_MEMBERS, async () => {
            await this._showMembers();
        });

        this._events.on(Events.ROOM.SHOW_HISTORY, async () => {
            await this._showHistory();
        });

        this._events.on(Events.ROOM.SHOW_SECURITY, async () => {
            await this._showSecurity();
        });

        // From the security page to members / key history: one modal after the other
        this._events.on(Events.ROOM.SECURITY_GOTO, (target) => {
            const el = document.getElementById(Modals.ROOM.SECURITY);
            el?.addEventListener("hidden.bs.modal", () => {
                if (target === "members") this._showMembers();
                if (target === "history") this._showHistory();
            }, {once: true});
            this._events.emit(Events.MODAL.CLOSE, Modals.ROOM.SECURITY);
        });

        this._events.on(Events.ROOM.REMOVE_MEMBER, async (memberId) => {
            await this._removeMember(memberId);
        });

        // A tap on a message shows who sent it (fingerprint, signature) — not on its buttons
        // (image, document) or the quote of a reply
        document.addEventListener("click", (e) => {
            const content = e.target.closest("#ct_room .message-item .content");
            if (!content || e.target.closest("button, a, [data-action]")) return;
            this._showMessageInfo(content.id).catch(err => log.error("message info failed:", err));
        });

        this._events.on(Events.CHAT.REPLY, async (messageId) => {
            await this._setReply(messageId);
        });

        this._events.on(Events.CHAT.CANCEL_REPLY, () => this._setReply(null));

        this._events.on(Events.CHAT.JUMP_TO, (messageId) => this._jumpTo(messageId));

        this._events.on(Events.CHAT.SEND_MESSAGE, async (msg) => {
            await this.sendMessage();
        });

        this._events.on(Events.CHAT.COPY_ACTIVE_ROOM, async (msg) => {
            await this._copySharedRoom();
        });

        this._events.on(Events.CHAT.SHARE_ACTIVE_ROOM, async (msg) => {
            await this._shareRoom();
        });

        this._events.on(Events.CHAT.RENEW_SHARE_CODE, async () => {
            await this._share?.render();
        });

        this._events.on(Events.CHAT.SEND_FILE, async (msg) => {
            await this.sendFile();
        });

        this._events.on(Events.CHAT.SEND_DOCUMENT, async () => {
            await this.sendDocument();
        });

        this._events.on(Events.CHAT.OPEN_FILE, async (fileId) => {
            try {
                await this._downloadDocument(fileId);
            } catch (error) {
                log.error("loading a file failed:", error.message);
                this._events.emit(Notifications.WARNING, {header: "Document", msg: "The document could not be loaded."});
            }
        });

        this._events.on(Events.CHAT.OPEN_IMAGE, async (fileId) => {
            try {
                let file = await this.getOrRequestFile(fileId);
                await this.showImageModal(file);
            } catch (error) {
                // Handles network/transfer errors and timeouts in one place
                log.error("loading a file failed:", error.message);
            }

        });


        // Must stay synchronous up to navigator.share(): iOS only allows sharing in the click itself
        this._events.on(Events.CHAT.SHARE_IMAGE, () => {
            this._shareImage();
        });

        this._events.on(Events.CHAT.EDIT_ACTIVE_ROOM, async (msg) => {
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.EDIT_ROOM);
            this._fillEditRoomModal();
        });

        this._events.on(Events.CHAT.UPDATE_ACTIVE_ROOM, async (msg) => {
            this._events.emit(Events.MODAL.CLOSE, Modals.ROOM.EDIT_ROOM);
            await this._updateRoomFromModal();
        });

        this._events.on(Events.CHAT.LEAVE_ACTIVE_ROOM_ASK, async (msg) => {
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.LEAVE_ROOM);
        });

        this._events.on(Events.CHAT.LEAVE_ACTIVE_ROOM, async (msg) => {
            log.debug("leave room", this._roomId);

            // Tells the others (they rotate without this device) and deletes the room here
            await this._roomKeys.leave(this._roomId);

            this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
        });

        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM_ASK, async (msg) => {
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.CLEAN_ROOM);
        });

        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM, async (msg) => {
            log.debug("clean room on this device", this._roomId);
            await this._db.cleanRoom(this._roomId);
            this._cleanActiveRoom();
        });

        // The server forwards the clean to the other members (offline ones get it on their next join).
        // A signed message right after it tells everybody who cleared the chat.
        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM_SERVER, async (msg) => {
            log.debug("clean room everywhere", this._roomId);
            this._events.emit(Events.WS.CLEAN_ROOM, this._roomId);
            await this._db.cleanRoom(this._roomId);
            this._cleanActiveRoom();

            const notice = await this._roomKeys.encryptMessage(this._roomId, {
                type: Message.TYPE_CLEAN, content: "", ttl: this._effectiveRoomTTL(), store: this._roomStore,
            });
            if (!notice) return;
            await this._newMessage(notice);
            this._events.emit(Events.WS.SEND_MESSAGE, notice);
        });

        // Another member cleaned the room — show what is left (messages newer than the clean)
        this._events.on(Events.CHAT.ROOM_CLEANED, async (roomId) => {
            if (roomId !== this._roomId || !this._onRoomPage) return;
            this._cleanActiveRoom();
            const loaded = await this._getLatestMessages();
            if (loaded) this._scrollToBottom();
        });

        this._events.on(Events.CHAT.MESSAGE, async (msg) => {
            if (msg.isRoom(this._roomId)) {
                await this._newMessage(msg);
            }
        });

        // this will open the room with the given id (action is coming from the room list)
        this._events.on(Events.ROOM.OPEN_ROOM, async (roomId) => {
            this._events.emit(Events.STATE.ROOM, roomId);
        })

        // The server sends the TTL and store setting in force after every join — new messages use them
        this._events.on(Events.WS.ROOM_INFO, (info) => {
            if (info.id !== this._roomId) return;
            this._roomTTL = info.ttl;
            if (info.store !== undefined) this._roomStore = info.store;
            this._renderRoomInfo();
        });

        // Delete time chosen in the timer menu of the chat footer
        // Expired messages were deleted from the database — remove them from the chat as well
        this._events.on(Events.CHAT.MESSAGES_EXPIRED, (expired) => {
            for (const m of expired) {
                if (m.roomId === this._roomId) this._removeMessageHTML(m.id);
            }
        });

        this._events.on(Events.CHAT.TICK, (now) => this._updateRemainingTimes(now));

        this._events.on(Events.STATE.ROOM, async (roomId) => {
            log.debug("open room", roomId);

            const room = await this._db.getRoom(roomId);
            if (!room) return;

            this._roomId = roomId;
            this._room = room;
            this._roomTTL   = room.ttl;
            this._sendTTL   = this._clampSendTTL(room.messageTTL || 0); // older free values → step
            this._roomStore = room.store;
            this._roomNotification = room.pushNotifications;
            this._roomName = await this._aes.decrypt(room.name, this._keyStore.getMasterKey());
            this._replyTo = null; // the reply bar belongs to the room it was opened in

            this._events.emit(Events.CHANGE.PAGE, Pages.ROOM);
        });

        // Image / document entry of the footer menu opens the hidden file input
        this._events.on(Events.CHAT.PICK_FILE, (inputId) => document.getElementById(inputId)?.click());

        document.addEventListener('submit', (e) => {
            if (e.target.id === 'send_message_form') {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this._events.on(Events.STATE.PAGE, async (pageName) => {
            this._onRoomPage = pageName === Pages.ROOM;

            if(pageName === Pages.ROOM){
                // textContent: the room name comes from the invite code of another user
                document.getElementById('ro_room_name').textContent = this._roomName;

                // Header bar, status bar area and footer buttons in the color of the room
                // (same as its bubble in the room list)
                const hue = idHue(this._roomId);
                const header = document.querySelector('#appHeader .appHeader');
                header.classList.add('room-color');
                header.style.setProperty('--room-hue', hue);
                document.getElementById('appContent').style.setProperty('--room-hue', hue);
                this._renderRoomInfo();
                this._renderRoomState();

                this._cleanActiveRoom();

                const loaded = await this._getLatestMessages();
                if (!loaded) return; // a newer load of the room page took over
                this._scrollToBottom();
            }
        });
    }

    async _updateRoomFromModal(){
        const modalEl = document.getElementById(Modals.ROOM.EDIT_ROOM);

        const roomName = modalEl.querySelector('input[name="room_name"]');
        const roomNotification = modalEl.querySelector('input[name="room_notification"]');
        const messageTTL = modalEl.querySelector('select[name="message_ttl"]');

        this._sendTTL = this._clampSendTTL(Number(messageTTL.value) || 0);

        // Only local settings — TTL and store are fixed since the room was created
        await this._db.updateRoomFields(this._roomId, {
            name: await this._aes.encrypt(roomName.value, this._keyStore.getMasterKey()),
            pushNotifications: roomNotification.checked,
            messageTTL: this._sendTTL,
        });

        this._events.emit(Events.STATE.ROOM, this._roomId);
    }

    _fillEditRoomModal(){
        const modalEl = document.getElementById(Modals.ROOM.EDIT_ROOM);

        const roomName = modalEl.querySelector('input[name="room_name"]');
        const roomNotification = modalEl.querySelector('input[name="room_notification"]');
        const roomMaxTTL = modalEl.querySelector('[data-field="room_max_ttl"]');
        const messageTTL = modalEl.querySelector('select[name="message_ttl"]');
        const roomStore = modalEl.querySelector('input[name="room_store"]');

        roomName.value = this._roomName;
        roomNotification.checked = this._roomNotification;
        roomStore.checked = this._roomStore;

        roomMaxTTL.textContent = formatTTL(this._effectiveRoomTTL());

        // Room TTL plus every fixed step that is shorter
        const roomTTL = this._effectiveRoomTTL();
        messageTTL.innerHTML = `<option value="0">Max. lifetime (${formatTTL(roomTTL)})</option>` +
            MESSAGE_TTL_STEPS.filter(s => s < roomTTL)
                .map(s => `<option value="${s}">${formatTTL(s)}</option>`).join("");
        messageTTL.value = String(this._sendTTL || 0);
    }

    // Invite code of the open room with a new invite code and invite secret, encrypted with the
    // PIN if one is given. Returns {code, expires}; code is null if the room has no epoch yet
    // (not connected to the server yet) or this device is no member.
    async _inviteCode(pin) {
        const created = await this._roomKeys.newInvite(this._roomId);
        if (!created) return {code: null, expires: null};

        return {code: await this._invite.encode(created.invite, pin), expires: created.expires};
    }

    // Copies the code shown in the share dialog (a new one if it has expired)
    async _copySharedRoom(){
        const modalEl = document.getElementById(Modals.ROOM.SHARE_ROOM);
        const copyBtn = modalEl.querySelector('[data-field="copy_btn"]');

        if (!this._share?.code) return;
        if (this._share.expires !== null && Date.now() >= this._share.expires) await this._share.render();

        await navigator.clipboard.writeText(this._share.code);

        const original = copyBtn.innerHTML;
        copyBtn.innerHTML = '<ion-icon name="checkmark-outline"></ion-icon> Copied!';
        setTimeout(() => { copyBtn.innerHTML = original; }, 2000);
    }

    // Share dialog: QR code with a join code that is valid once and for a few minutes. The
    // countdown shows how long; an expired code is covered and can be renewed.
    async _shareRoom(){
        const modalEl = document.getElementById(Modals.ROOM.SHARE_ROOM);

        const qrContainer = modalEl.querySelector('[data-field="qr_code"]');
        const expiredEl = modalEl.querySelector('[data-field="qr_expired"]');
        const validityEl = modalEl.querySelector('[data-field="share_validity"]');
        const pinInput = modalEl.querySelector('input[name="share_pin"]');

        pinInput.value = "";

        let renderId = 0;

        const tick = () => {
            if (!this._share) return;
            if (this._share.expires === null) {
                validityEl.textContent = "Not usable yet — this room is not connected to the server or you are no member";
                expiredEl.classList.add("d-none");
                return;
            }

            const left = this._share.expires - Date.now();
            const expired = left <= 0;
            expiredEl.classList.toggle("d-none", !expired);
            validityEl.textContent = expired
                ? "This code has expired"
                : `Valid once, for ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")} min`;
        };

        // Every render creates a new join code
        const render = async () => {
            const id = ++renderId;
            const {code, expires} = await this._inviteCode(pinInput.value);
            if (id !== renderId) return; // a newer render was started while deriving the PIN key

            this._share = {code, expires, render};

            qrContainer.innerHTML = "";
            if (!code) {
                tick();
                return;
            }
            new QRCode(qrContainer, {
                text: code,
                width: 280,
                height: 280,
                colorDark: "#000",
                colorLight: "#fff",
                correctLevel: QRCode.CorrectLevel.L // short code + low correction = large modules
            });
            tick();
        };

        // White quiet zone around the code: scanners need it, especially in dark mode
        qrContainer.style.background = "#fff";
        qrContainer.style.padding = "16px";
        qrContainer.style.width = "fit-content";
        qrContainer.style.margin = "0 auto";

        // Re-render with the PIN, debounced because the PIN key derivation (PBKDF2) is slow.
        // A PIN change gives a new join code as well — the shown one may already be scanned.
        let timer = null;
        pinInput.oninput = () => {
            clearTimeout(timer);
            timer = setTimeout(render, 400);
        };

        this._share = null;
        await render();

        const ticker = setInterval(tick, 1000);
        modalEl.addEventListener("hidden.bs.modal", () => {
            clearInterval(ticker);
            clearTimeout(timer);
            this._share = null;
        }, {once: true});

        this._events.emit(Events.MODAL.OPEN, Modals.ROOM.SHARE_ROOM);
    }

    async sendFile() {
        const input = document.getElementById("ct_img_input");
        if (input.files.length === 0) return;

        const file = await this.limitToHD(input.files[0]);
        input.value = ""; // the same file can be chosen again

        // Type and size of the image that is sent (after scaling), shown in the bubble
        await this._sendFileMessage(file, Message.TYPE_IMAGE, {type: file.type, size: file.size});
    }

    // Any file (PDF, Word, ...). Name and size are sent encrypted in the message content,
    // so the bubble can show them before the file itself is downloaded.
    async sendDocument() {
        const input = document.getElementById("ct_doc_input");
        if (input.files.length === 0) return;

        const file = input.files[0];
        input.value = "";

        await this._sendFileMessage(file, Message.TYPE_FILE, {name: file.name.slice(0, 200), size: file.size});
    }

    // Encrypts the file with the file key of the current epoch, stores it locally and sends the
    // message plus the file chunks. info ({type?, name?, size}) goes into the signed content
    // together with the hash of the encrypted file, so nobody can swap the file on the server.
    async _sendFileMessage(file, type, info) {
        const current = await this._roomKeys.currentKeys(this._roomId);
        if (!current) return this._notMemberYet();

        // Sizes of the encrypted (padded) data — that is what is sent
        const blob = await this._aes.encryptFile(file, current.keys.fileKey);
        const totalChunks = Math.ceil(blob.byteLength / CHUNK_SIZE);

        // Limit of the server (MAX_FILE_SIZE_MB) — it would reject the upload
        const maxSize = Number(document.querySelector('meta[name="max-file-size"]')?.content) || 0;
        if (maxSize > 0 && blob.byteLength > maxSize) {
            this._events.emit(Notifications.WARNING, {
                header: "File too large",
                msg: `Files can be at most ${formatBytes(maxSize)} (this one: ${formatBytes(blob.byteLength)}).`,
            });
            return;
        }

        const hash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", blob)));
        const msg = await this._roomKeys.encryptMessage(this._roomId, {
            type, content: JSON.stringify({...info, hash}),
            chunkSize: CHUNK_SIZE, chunksTotal: totalChunks, ttl: this._messageTTL(), store: this._roomStore,
        });
        if (!msg) return this._notMemberYet();

        const fileM = new File({
            id: msg.id,
            blob: blob,
            roomId: this._roomId,
            chunkSize: CHUNK_SIZE,
            chunksTotal: totalChunks,
            ttl: this._messageTTL(),
            store: this._roomStore,
            mimeType: "application/octet-stream", // the real type is inside the encrypted data
            totalSize: blob.byteLength,
        });

        this._db.addFile(fileM);
        this._events.emit(Events.WS.SEND_FILE, fileM);

        await this._newMessage(msg);
        this._events.emit(Events.WS.SEND_MESSAGE, msg);
    }

    // Decrypts the file of a message with the file key of the message's epoch and checks it
    // against the hash in the signed message. Returns {blob, info}.
    async _openFile(file) {
        const row = await this._db.getMessage(file.id);
        if (!row) throw new Error("message of the file is missing");

        const msg = Message.fromDB(row);
        const plain = await this._roomKeys.decryptMessage(msg);
        const keys = await this._roomKeys.keysOf(msg.roomId, msg.epoch);
        if (!plain || !keys) throw new Error("no keys for the epoch of the file");

        let info = {};
        try {
            info = JSON.parse(plain.content) ?? {};
        } catch { /* no info */ }

        if (info.hash) {
            const hash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", file.blob)));
            if (hash !== info.hash) throw new Error("file does not match its message");
        }

        return {blob: await this._aes.decryptFileBlob(file.blob, file.mimeType, keys.fileKey), info};
    }

    _notMemberYet() {
        this._events.emit(Notifications.WARNING, {
            header: "Not a member yet",
            msg: "You can send messages once a member approved your join request.",
        });
    }

    // Loads the document (from the device or the server), decrypts it and saves it under its
    // original name. The browser shows its usual download; on iPhone it opens the preview,
    // from where it can be saved to Files or opened in Word, a PDF viewer, ...
    async _downloadDocument(fileId) {
        // Documents can be much larger than images — give the download more time
        const file = await this.getOrRequestFile(fileId, 120 * 1000);
        const {blob, info} = await this._openFile(file);
        const name = info.name || "document";

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60 * 1000); // the download needs the URL a moment longer
    }

    async getOrRequestFile(fileId, timeoutMs = 15000) {
        // 1. Fast path: file is already stored locally (saves network and event overhead)
        const cachedFile = await this._db.getFile(fileId);
        if (cachedFile) {
            return cachedFile;
        }

        log.debug("requesting file from the server", fileId);

        // 2. Wait for the transfer event and expose the result as a promise
        return new Promise((resolve, reject) => {
            let timer = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this._events.off(Events.WS.RECEIVED_FILE, onDone);
            };

            // RECEIVED_FILE carries the assembled File (the database stores it in parallel)
            const onDone = (file) => {
                // Ignore transfers of other files
                if (!file || file.id !== fileId) return;

                cleanup();
                resolve(file);
            };

            // The timeout prevents hanging promises and memory leaks
            timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timeout: file transfer for '${fileId}' did not finish in time.`));
            }, timeoutMs);

            // Register the listener, then send the request
            this._events.on(Events.WS.RECEIVED_FILE, onDone);
            this._events.emit(Events.WS.TRANSFER_REQUEST, { id: fileId, roomId: this._roomId });
        });
    }

    async limitToHD(file, quality = 0.85) {
        const MAX = 2560;

        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
        } catch (e) {
            log.warn("image decode failed, sending the original:", file.type, e);
            return file;
        }

        if (bitmap.width <= MAX && bitmap.height <= MAX) {
            return file;
        }

        const scale = Math.min(MAX / bitmap.width, MAX / bitmap.height);
        const width  = Math.round(bitmap.width  * scale);
        const height = Math.round(bitmap.height * scale);

        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);

        // HEIC → always convert to JPEG
        const isHEIC = file.type === 'image/heic' ||
            file.type === 'image/heif' ||
            file.name?.toLowerCase().endsWith('.heic') ||
            file.name?.toLowerCase().endsWith('.heif');

        const outputType = isHEIC ? 'image/jpeg' : file.type;
        return await canvas.convertToBlob({ type: outputType, quality });
    }

    async sendMessage(){
        const msgRaw = document.getElementById("ct_msg_input").value;

        // ignore empty messages
        if(msgRaw.length === 0){
            return
        }

        // check max length
        if(msgRaw.length > 1024){
            notification("ct_msg_maxlength", 5000);
            return
        }

        const msg = await this._roomKeys.encryptMessage(this._roomId, {
            type: Message.TYPE_TEXT, content: msgRaw, replyTo: this._replyTo, ttl: this._messageTTL(), store: this._roomStore,
        });
        if (!msg) return this._notMemberYet();

        document.getElementById("ct_msg_input").value = "";
        await this._setReply(null);

        await this._newMessage(msg);

        this._events.emit(Events.WS.SEND_MESSAGE, msg);

    }

    // -------------------------------------------------------------------------
    // HTML rendering
    // -------------------------------------------------------------------------

    // Render a new message in the active room and add it to the room view
    async _newMessage(msg){
        this._checkTimeDivider(msg);

        await this._renderMessage(msg);
        this._markRead(msg.timestamp);
    }

    // Everything shown in the open room counts as read (unread badges on the home page)
    _markRead(timestamp) {
        if (!this._onRoomPage || !timestamp) return;
        this._db.markRoomRead(this._roomId, timestamp)
            .catch(err => log.error("marking room as read failed:", err));
    }

    async _renderMessage(msg) {
        if (msg.isExpired() || !msg.isVisible()) return;

        // Already shown (e.g. a message from the WebSocket arrived while the room was loading)
        if (document.getElementById(msg.id)) return;

        if (msg.isSystem()) {
            const text = await this._keyStore.openLocal(msg.content);
            if (document.getElementById(msg.id)) return;
            document.getElementById('ct_room').insertAdjacentHTML('beforeend',
                `<div class="message-divider system-message" id="${msg.id}">${msg._escape(text)}</div>`);
            return;
        }

        if (msg.aliasId === undefined) return; // marker of a clean

        // null: this device has no keys of the message's epoch (yet)
        const plain = await this._roomKeys.decryptMessage(msg);
        if (!plain) return;

        // Not signed by the member it claims to come from — it is deleted, never shown. (Checked
        // before storing already, this catches messages that came before the keys of their epoch.)
        if (!plain.verified) {
            log.warn("message dropped: signature not valid", msg.id);
            await this._db.deleteMessage(msg.id);
            return;
        }

        if (msg.isClean()) {
            const who = plain.own ? "You" : msg._escape(plain.alias);
            if (document.getElementById(msg.id)) return;
            document.getElementById('ct_room').insertAdjacentHTML('beforeend',
                `<div class="message-divider system-message" id="${msg.id}">${who} cleared the chat for everyone</div>`);
            return;
        }

        const isOwn    = plain.own;
        const bubble   = msg._renderBubble(plain.content);
        const status   = isOwn ? msg._renderStatus() : '';
        // Only messages with a valid signature are shown — the mark says so
        const signed   = `<ion-icon name="shield-checkmark-outline" class="msg-signed" title="Signed by ${msg._escape(plain.alias)}"></ion-icon>`;
        const title    = !isOwn
            ? `<div class="title alias-color" style="--alias-hue: ${idHue(plain.senderId)}" alias-id="${msg._escape(plain.senderId)}">${msg._escape(plain.alias)}</div>`
            : '';
        const quote    = plain.replyTo ? await this._quoteHTML(plain.replyTo) : '';

        if (document.getElementById(msg.id)) return;

        document.getElementById('ct_room').insertAdjacentHTML('beforeend', `
        <div class="message-item${isOwn ? ' user' : ''}">
            <div id="${msg.id}" class="content">
                ${title}
                ${quote}
                <div class="bubble text-line-break">${bubble}</div>
                <div class="footer">${signed} ${msg.formattedTime} ${this._ttlHTML(msg)} ${status}</div>
            </div>
        </div>`);
    }

    // Clean the active room by removing all message items
    _cleanActiveRoom(){
        $("#ct_room").html("");

        this._roomTimestamp = null;
    }

    // request last x messages and render them
    // Returns false if a newer load started meanwhile — rendering is async (decrypting), so two
    // overlapping loads would otherwise both append their messages.
    async _getLatestMessages(){
        const load = ++this._messageLoad;
        const messageArray = await this._db.getLatestMessages(this._roomId);

        for (const msg of messageArray) {
            if (load !== this._messageLoad) return false;
            await this._newMessage(Message.fromDB(msg));
        }
        return load === this._messageLoad;
    }

    // Jumps to the newest message. Again in the next frame, because the page may not be laid
    // out yet right after it was opened (scrollHeight would still be 0).
    _scrollToBottom() {
        const scroll = () => {
            const el = document.getElementById("ct_room");
            if (el) el.scrollTop = el.scrollHeight;
        };
        scroll();
        requestAnimationFrame(scroll);
    }

    // Returns the date divider HTML (call when date changes between messages)
    _checkTimeDivider(msg) {
        const timeStamp = msg.date;

        if(this._roomTimestamp === undefined || this._roomTimestamp === null || this._roomTimestamp.getDate() !== timeStamp.getDate() || this._roomTimestamp.getMonth() !== timeStamp.getMonth() || this._roomTimestamp.getFullYear() !== timeStamp.getFullYear()){
            $("#ct_room").append(`<div class="message-divider">${msg.formattedDate}</div>`);
        }

        this._roomTimestamp = timeStamp;
    }

    // Update synced status icon in existing DOM element
    _updateStatusHTML(msg) {
        const footer = $(`#${msg.id} .footer`);
        footer.find('ion-icon.msg-status').remove();
        footer.append(msg._renderStatus());

        // The server echo carries the TTL and timestamp in force
        const ttl = document.querySelector(`[id="${msg.id}"] .msg-ttl`);
        if (ttl) {
            ttl.dataset.expires = msg.expiresAt;
            this._updateRemainingTimes();
        }
    }

    // -------------------------------------------------------------------------
    // Message TTL
    // -------------------------------------------------------------------------

    // Room TTL in seconds; unknown (0) means the maximum
    _effectiveRoomTTL() {
        return this._roomTTL > 0 ? Math.min(this._roomTTL, Message.MAX_TTL) : Message.MAX_TTL;
    }

    // 0 if the TTL is not shorter than the room maximum (= use the room maximum), otherwise one
    // of the fixed steps (older free values are rounded down like the server does)
    _clampSendTTL(ttl) {
        return ttl > 0 && ttl < this._effectiveRoomTTL() ? snapTTL(ttl) : 0;
    }

    // TTL of the next message: the chosen one, but never longer than the room TTL
    _messageTTL() {
        const roomTTL = this._effectiveRoomTTL();
        return this._sendTTL > 0 ? Math.min(this._sendTTL, roomTTL) : roomTTL;
    }

    _ttlHTML(msg) {
        const remaining = Math.max(0, Math.round((msg.expiresAt - Date.now()) / 1000));
        return `<span class="msg-ttl" data-expires="${msg.expiresAt}" title="Deleted on ${new Date(msg.expiresAt).toLocaleString()}">` +
            `<ion-icon name="timer-outline"></ion-icon> ${formatDuration(remaining)}</span>`;
    }

    // Updates the remaining time of every message; removes the ones that just expired
    _updateRemainingTimes(now = Date.now()) {
        document.querySelectorAll('#ct_room .msg-ttl[data-expires]').forEach(el => {
            const expires = Number(el.dataset.expires);
            if (expires <= now) {
                this._removeMessageHTML(el.closest('.content').id);
                return;
            }
            el.title = `Deleted on ${new Date(expires).toLocaleString()}`;
            el.innerHTML = `<ion-icon name="timer-outline"></ion-icon> ${formatDuration(Math.round((expires - now) / 1000))}`;
        });
    }

    _removeMessageHTML(messageId) {
        const content = document.getElementById(messageId);
        if (!content) return;
        (content.closest('.message-item') ?? content).remove();

        // Remove date dividers that have no messages left
        document.querySelectorAll('#ct_room .message-divider').forEach(divider => {
            const next = divider.nextElementSibling;
            if (!next || next.classList.contains('message-divider')) divider.remove();
        });
    }

    // Header line above the room name: security status (tap: security page), maximum lifetime
    // and whether messages are kept on the server
    async _renderRoomInfo() {
        const el = document.getElementById('ro_room_ttl');
        if (!el) return;

        const info = await this._roomKeys.securityInfo(this._roomId);
        const secure = info?.epoch > 0;
        const security = `<a href="#" class="room-security" data-action="room:show_security" title="Security of this room">` +
            `<ion-icon name="${secure ? "lock-closed" : "lock-open-outline"}"></ion-icon>` +
            (secure ? ` E${info.epoch} · <ion-icon name="people-outline"></ion-icon> ${info.members}` : " not ready") + `</a>`;

        const store = this._roomStore
            ? `<span class="room-store" title="Keep on Server: messages are kept encrypted on the server"><ion-icon name="cloud-done-outline"></ion-icon> server</span>`
            : `<span class="room-store" title="Keep on Server is off: only members who are online receive messages"><ion-icon name="cloud-offline-outline"></ion-icon> live only</span>`;

        el.innerHTML = `${security}<span class="room-store"><ion-icon name="timer-outline"></ion-icon> max ${formatTTL(this._effectiveRoomTTL())}</span>${store}`;
    }


    async showImageModal(file) {
        const {blob} = await this._openFile(file);
        const url = URL.createObjectURL(blob);

        const img = document.querySelector('#ct_image img');

        if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);

        img.src = url;
        img.dataset.objectUrl = url;

        // Prepared before the click: iOS only allows navigator.share() directly in the click
        // handler — an await (e.g. fetching the image first) loses the user gesture.
        // window.File: "File" in this module is the domain class.
        this._shareFile = new window.File([blob], imageFileName(blob.type), { type: blob.type });
        this._shareUrl = url;

        $("#ct_image").one('hidden.bs.modal', () => {
            if (img.dataset.objectUrl === url) {
                URL.revokeObjectURL(url);
                delete img.dataset.objectUrl;
                img.src = '';
                this._shareFile = null;
                this._shareUrl = null;
            }
        });

        $("#ct_image").modal('show');
    }

    // -------------------------------------------------------------------------
    // Room state and members
    // -------------------------------------------------------------------------

    // Banner above the chat while waiting for approval or after being removed; sending is
    // disabled then
    async _renderRoomState() {
        const el = document.getElementById("ro_room_state");
        if (!el || !this._room) return;

        const own = await this._roomKeys.ownMemberId(this._roomId);
        const text = this._room.isPending()
            ? `Waiting for approval — the member who invited you has to accept your request. Your fingerprint: ${own ? fingerprint(own) : "?"}`
            : this._room.isRemoved() ? "You are no member of this room anymore." : "";

        el.textContent = text;
        el.hidden = !text;

        // The chat starts below the banner, otherwise it covers the first messages
        const chat = document.getElementById("ct_room");
        if (chat) chat.style.top = text ? `calc(56px + env(safe-area-inset-top) + ${el.offsetHeight}px)` : "";
        document.querySelectorAll('#send_message_form textarea, #send_message_form button').forEach(b => {
            b.disabled = !!text;
        });
    }

    // Member list of the current epoch: alias, fingerprint (compare in person), key age
    async _showMembers() {
        const members = await this._roomKeys.members(this._roomId);
        const own = members.find(m => m.own);
        const list = document.querySelector(`[id="${Modals.ROOM.MEMBERS}"] [data-field="members"]`);
        if (!list) return;

        const days = ms => ms === null ? "" : `key ${Math.floor(ms / 86400000)} days old`;
        list.innerHTML = members.map(m => `
            <li>
                <div class="in">
                    <div>
                        <strong class="alias-color" style="--alias-hue: ${idHue(m.memberId)}">${escapeHTML(m.alias || "?")}</strong>${m.own ? " (you)" : ""}
                        <div class="text-muted small"><code>${m.fingerprint}</code> · ${days(m.keyAge)}</div>
                    </div>
                    ${m.own ? "" : `<button type="button" class="btn btn-sm btn-outline-danger" data-action="room:remove_member" data-body="${m.memberId}">Remove</button>`}
                </div>
            </li>`).join("") || `<li class="text-muted">No members known yet</li>`;

        const ownEl = document.querySelector(`[id="${Modals.ROOM.MEMBERS}"] [data-field="own_fingerprint"]`);
        if (ownEl) ownEl.textContent = own?.fingerprint ?? "";

        this._events.emit(Events.MODAL.OPEN, Modals.ROOM.MEMBERS);
    }

    // -------------------------------------------------------------------------
    // Message info, verification and replies
    // -------------------------------------------------------------------------

    // A shown message, decrypted and checked: {msg, plain} — null if it is gone or not valid
    async _openShown(messageId) {
        const row = await this._db.getMessage(messageId);
        if (!row) return null;
        const msg = Message.fromDB(row);
        const plain = await this._roomKeys.decryptMessage(msg);
        return plain?.verified ? {msg, plain} : null;
    }

    // Who sent the message: alias, fingerprint (compare in person), valid signature — and "Reply"
    async _showMessageInfo(messageId) {
        const shown = await this._openShown(messageId);
        if (!shown) return;
        const {msg, plain} = shown;

        const modalEl = document.getElementById(Modals.ROOM.MESSAGE);
        const field = name => modalEl.querySelector(`[data-field="${name}"]`);

        const aliasEl = field("alias");
        aliasEl.textContent = plain.own ? `${plain.alias} (you)` : plain.alias; // alias of another user: text only
        aliasEl.style.setProperty("--alias-hue", idHue(plain.senderId));
        field("time").textContent = msg.date.toLocaleString();
        field("fingerprint").textContent = fingerprint(plain.senderId);
        field("reply").dataset.body = msg.id;

        this._events.emit(Events.MODAL.OPEN, Modals.ROOM.MESSAGE);
    }

    // Short text of a message for quotes: {alias, senderId, text} — null if it is not on this
    // device (anymore) or not valid. Taken from the own copy, never from the reply: nobody can put
    // words into someone else's mouth.
    async _quoteOf(messageId) {
        const shown = await this._openShown(messageId);
        if (!shown) return null;
        const {msg, plain} = shown;

        let text = plain.content;
        if (msg.isImage()) text = "Image";
        if (msg.isFile()) text = "Document";
        if (text.length > 100) text = text.slice(0, 100) + "…";
        return {alias: plain.own ? "You" : plain.alias, senderId: plain.senderId, text};
    }

    async _quoteHTML(messageId) {
        const q = await this._quoteOf(messageId);
        if (!q) return `<div class="msg-reply missing">Reply to a message that is not available</div>`;
        return `<a href="#" class="msg-reply" data-action="chat:jump_to" data-body="${escapeHTML(messageId)}" style="--alias-hue: ${idHue(q.senderId)}">` +
            `<strong class="alias-color">${escapeHTML(q.alias)}</strong>${escapeHTML(q.text)}</a>`;
    }

    // Shows (messageId) or hides (null) the bar of the message the next text answers
    async _setReply(messageId) {
        const bar = document.getElementById("ct_reply");
        const q = messageId ? await this._quoteOf(messageId) : null;
        this._replyTo = q ? messageId : null;
        if (!bar) return;

        bar.hidden = !q;
        if (!q) return;
        const alias = bar.querySelector('[data-field="alias"]');
        alias.textContent = q.alias;
        bar.querySelector('[data-field="text"]').textContent = q.text;
        document.getElementById("ct_msg_input")?.focus();
    }

    _jumpTo(messageId) {
        const el = document.getElementById(messageId);
        if (!el) return;
        el.scrollIntoView({behavior: "smooth", block: "center"});
        el.classList.add("msg-flash");
        setTimeout(() => el.classList.remove("msg-flash"), 1500);
    }

    // Security page: status of the room, how the keys work and what to take care of
    async _showSecurity() {
        const info = await this._roomKeys.securityInfo(this._roomId);
        const el = document.querySelector(`[id="${Modals.ROOM.SECURITY}"] [data-field="status"]`);
        if (!el) return;

        if (info?.epoch > 0) {
            const since = info.since ? new Date(info.since).toLocaleString() : "";
            el.innerHTML = `
                <div class="security-ok"><ion-icon name="lock-closed"></ion-icon> End-to-end encrypted</div>
                <div class="small">Epoch <strong>${info.epoch}</strong>${since ? ` · since ${escapeHTML(since)}` : ""}
                    · <strong>${info.members}</strong> member${info.members === 1 ? "" : "s"} can read new messages</div>
                <div class="small text-muted">Your fingerprint: <code>${escapeHTML(info.fingerprint)}</code></div>`;
        } else {
            const text = info?.status === "pending" ? "Waiting for approval — you have no epoch key yet."
                : info?.status === "removed" ? "You are no member anymore — you get no new keys."
                : "Not connected yet — the first epoch key is made when the room is on the server.";
            el.innerHTML = `<div class="security-wait"><ion-icon name="lock-open-outline"></ion-icon> ${text}</div>
                ${info ? `<div class="small text-muted">Your fingerprint: <code>${escapeHTML(info.fingerprint)}</code></div>` : ""}`;
        }

        this._events.emit(Events.MODAL.OPEN, Modals.ROOM.SECURITY);
    }

    // Key history: a timeline of the epochs, newest first. Tapping one shows its members, the
    // hashes of the chain and how many of its messages are on this device.
    async _showHistory() {
        const history = await this._roomKeys.history(this._roomId);
        const list = document.querySelector(`[id="${Modals.ROOM.HISTORY}"] [data-field="history"]`);
        if (!list) return;

        // Aliases come from other members: always escaped
        const name = (p, start) => !p ? "someone" : p.own ? (start ? "You" : "you")
            : `<span class="alias-color" style="--alias-hue: ${idHue(p.memberId)}">${escapeHTML(p.alias)}</span>`;
        const names = people => people.map(p => name(p, false)).join(", ");

        const what = h => {
            const by = h.signer ? ` — by ${name(h.signer, false)}` : "";
            switch (h.reason) {
                case "create": return ["add-circle-outline", `Room created${by}`];
                case "add":    return ["person-add-outline", h.subject?.own ? `You joined — added by ${name(h.signer, false)}` : `${name(h.signer, true)} added ${name(h.subject, false)}`];
                case "leave":  return ["exit-outline", `${name(h.subject, true)} left${by}`];
                case "remove": return ["person-remove-outline", `${name(h.signer, true)} removed ${name(h.subject, false)}`];
                case "renew":  return ["refresh-outline", `Key renewed${by}`];
            }
            // Epochs from before the history was kept: what changed in the member list
            const changes = [
                h.added.length ? `added ${names(h.added)}` : "",
                h.removed.length ? `removed ${names(h.removed)}` : "",
            ].filter(Boolean).join(", ");
            return ["key-outline", changes ? `Members changed: ${changes}` : "Key changed"];
        };

        // First 4 bytes of a hash as hex; the first epoch points to nothing (all zero)
        const short = hash => {
            if (!hash) return "—";
            const bytes = Uint8Array.from(atob(hash), c => c.charCodeAt(0));
            if (bytes.every(b => b === 0)) return "start";
            return Array.from(bytes.subarray(0, 4), b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
        };
        list.innerHTML = history.map((h, i) => {
            const [icon, text] = what(h);
            const tags = [
                h.current ? '<span class="badge badge-primary">current</span>' : "",
                i === history.length - 1 && !h.current && h.reason !== "create" ? '<span class="badge badge-secondary">first on this device</span>' : "",
            ].join(" ");
            return `
            <li class="${h.current ? "current" : ""}">
                <details>
                    <summary>
                        <div class="key-history-head">
                            <strong>Epoch ${h.epoch}</strong> ${tags}
                            <span class="key-history-time">${h.created ? escapeHTML(new Date(h.created).toLocaleString()) : ""}</span>
                        </div>
                        <div class="key-history-text"><ion-icon name="${icon}"></ion-icon> ${text}</div>
                    </summary>
                    <div class="key-history-details small">
                        <div class="text-muted">Members (${h.members.length})</div>
                        <ul>${h.members.map(m => `<li>${name(m, true)} <code>${m.fingerprint}</code></li>`).join("")}</ul>
                        <div class="text-muted">Chain <code>${short(h.prevHash)}</code> → <code>${short(h.headerHash)}</code></div>
                        <div class="text-muted">${h.messages} message${h.messages === 1 ? "" : "s"} of this epoch on this device</div>
                    </div>
                </details>
            </li>`;
        }).join("") || `<li class="text-muted">No key changes known yet</li>`;

        this._events.emit(Events.MODAL.OPEN, Modals.ROOM.HISTORY);
    }

    // First click arms the button, the second one removes the member
    async _removeMember(memberId) {
        const btn = document.querySelector(`[data-action="room:remove_member"][data-body="${memberId}"]`);
        if (btn && !btn.dataset.armed) {
            btn.dataset.armed = "1";
            btn.textContent = "Really remove?";
            return;
        }

        await this._roomKeys.removeMember(this._roomId, memberId);
        this._events.emit(Events.MODAL.CLOSE, Modals.ROOM.MEMBERS);
        this._events.emit(Notifications.INFO, {header: "Members", msg: "The member is removed with the next key change."});
    }

    // Shares the image of the image modal (CHAT.SHARE_IMAGE); downloads it where the browser
    // cannot share files (desktop).
    _shareImage() {
        const file = this._shareFile;
        if (!file) return;

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).catch(err => {
                if (err.name !== 'AbortError') log.error("share failed:", err);
            });
            return;
        }

        const a = document.createElement('a');
        a.href = this._shareUrl;
        a.download = file.name;
        a.click();
    }
}

// Aliases come from other members — never insert them as HTML
function escapeHTML(str) {
    const el = document.createElement("div");
    el.textContent = str ?? "";
    return el.innerHTML;
}

// File name with the extension of the image type, e.g. "chatbit-image.png"
function imageFileName(mimeType) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
                  'image/heic': 'heic', 'image/heif': 'heif' }[mimeType] || 'jpg';
    return `chatbit-image.${ext}`;
}
