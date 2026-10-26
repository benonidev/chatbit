import {Events} from "./event.js";
import {Pages} from "./page.js";
import {Message} from "../domain/message.js";
import {File, formatBytes} from "../domain/file.js";
import {Modals} from "./modal.js";
import {Room} from "../domain/room.js";
import {InviteCode} from "./invite.js";
import {formatDuration, formatTTL, MESSAGE_TTL_STEPS, snapTTL} from "./expiry.js";
import {inviteCode, joinWindow, joinWindowEnd} from "./join_code.js";
import {idHue} from "./color.js";
import {Notifications} from "./notification.js";

const CHUNK_SIZE = 64 * 1024; // 64KB

// Chat room page: renders messages, encrypts and sends text and images, loads images on demand
// and handles the room actions (share, edit, clean, leave).
export class ViewRoom {
    constructor(events, aes, keyStore, db) {
        this._events = events;
        this._aes   = aes;
        this._db   = db;
        this._keyStore = keyStore;
        this._invite = new InviteCode(aes);

        this._roomId = null;
        this._roomTimestamp = null;
        this._roomKey = null;
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

        this._alias = null;
        this._aliasId = null;
    }

    async init() {
        this._events.on(Events.WS.RECEIVED_MESSAGE, async (msg) => {
            if (msg.isRoom(this._roomId)) {
                console.log("WS Message received");
                console.log(msg);


                const aliasId = await this._aes.decrypt(msg.aliasId, this._roomKey);

                console.log(msg);
                if (aliasId === this._aliasId){
                    console.log("Own message received");

                    this._updateStatusHTML(msg);
                    this._markRead(msg.timestamp); // the server timestamp may be newer than the local one
                }else{
                    console.log("Message received from WS");
                    await this._newMessage(msg);
                }

                this._scrollToBottom();
            }
        });

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
                console.error(`Failed to load file ${fileId}:`, error.message);
                this._events.emit(Notifications.WARNING, {header: "Document", msg: "The document could not be loaded."});
            }
        });

        this._events.on(Events.CHAT.OPEN_IMAGE, async (fileId) => {
            console.log(`Open File with ID: ${fileId}`);

            try {
                let file = await this.getOrRequestFile(fileId);
                console.log(file);



                await this.showImageModal(file);
            } catch (error) {
                // Handles network/transfer errors and timeouts in one place
                console.error(`Failed to load file ${fileId}:`, error.message);
            }

        });


        // Must stay synchronous up to navigator.share(): iOS only allows sharing in the click itself
        this._events.on(Events.CHAT.SHARE_IMAGE, () => {
            this._shareImage();
        });

        this._events.on(Events.CHAT.EDIT_ACTIVE_ROOM, async (msg) => {
            console.log("Edit Active Room");
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.EDIT_ROOM);
            this._fillEditRoomModal();
        });

        this._events.on(Events.CHAT.UPDATE_ACTIVE_ROOM, async (msg) => {
            console.log("Update Active Room");
            this._events.emit(Events.MODAL.CLOSE, Modals.ROOM.EDIT_ROOM);
            await this._updateRoomFromModal();
        });

        this._events.on(Events.CHAT.LEAVE_ACTIVE_ROOM_ASK, async (msg) => {
            console.log("Leave Active Room Ask");
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.LEAVE_ROOM);
        });

        this._events.on(Events.CHAT.LEAVE_ACTIVE_ROOM, async (msg) => {
            console.log("Leave Active Room");

            await this._leaveRoom(this._roomId);

            this._events.emit(Events.WS.LEAVE_ROOM, this._roomId);

            this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
        });

        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM_ASK, async (msg) => {
            this._events.emit(Events.MODAL.OPEN, Modals.ROOM.CLEAN_ROOM);
        });

        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM, async (msg) => {
            console.log("Clean Active Room DB ID:", this._roomId);
            await this._db.cleanRoom(this._roomId);
            console.log("Clean Active Room");
            this._cleanActiveRoom();
        });

        // The server forwards the clean to the other members (offline ones get it on their next join)
        this._events.on(Events.CHAT.CLEAN_ACTIVE_ROOM_SERVER, async (msg) => {
            console.log("Clean Active Room everywhere:", this._roomId);
            this._events.emit(Events.WS.CLEAN_ROOM, this._roomId);
            await this._db.cleanRoom(this._roomId);
            this._cleanActiveRoom();
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
            console.log("View Room", roomId);

            this._roomId = roomId;
            this._roomKey = await this._keyStore.getRoomKey(roomId);


            const room = await this._db.getRoom(roomId);

            console.log("Get Room from DB");
            this._roomTTL   = room.ttl;
            this._sendTTL   = this._clampSendTTL(room.messageTTL || 0); // older free values → step
            this._roomStore = room.store;
            this._roomNotification = room.pushNotifications;
            this._roomName = await this._aes.decrypt(room.name, this._keyStore.getMasterKey());

            const profile = await this._db.getProfile();
            this._alias = profile.name;
            this._aliasId = profile.uid;

            this._events.emit(Events.CHANGE.PAGE, Pages.ROOM);
        });

        document.addEventListener('submit', (e) => {
            if (e.target.id === 'send_message_form') {
                e.preventDefault();
                console.log("Send Message");

                this.sendMessage();
            }
        });

        this._events.on(Events.STATE.PAGE, async (pageName) => {
            this._onRoomPage = pageName === Pages.ROOM;

            if(pageName === Pages.ROOM){
                console.log("View Room Page");

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

        const updateRoom = new Room({
            id: this._roomId,
            name: await this._aes.encrypt(roomName.value, this._keyStore.getMasterKey()),
            key: await this._aes.encrypt(await this._aes.exportKey(this._roomKey), this._keyStore.getMasterKey()),
            pushNotifications: roomNotification.checked,
            store: this._roomStore, // fixed since the room was created, like the TTL
            ttl: this._roomTTL, // fixed since the room was created, the server ignores any other value
            messageTTL: this._sendTTL
        })

        console.log(updateRoom);

        await this._db.updateRoom(updateRoom);

        this._events.emit(Events.STATE.ROOM, updateRoom.id);
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

    // Invite code of the open room with a new join code, encrypted with the PIN if one is given.
    // Returns {code, expires}; expires is null if the room has no join secret (not connected to
    // the server yet) — the server will not accept such a code.
    async _inviteCode(pin) {
        const joinKey = await this._keyStore.getJoinKey(this._roomId);
        const window = joinWindow();

        const code = await this._invite.encode({
            i: this._roomId,
            n: this._roomName,
            k: await this._aes.exportKey(this._roomKey),
            c: joinKey ? await inviteCode(joinKey, window) : "",
        }, pin);

        return {code, expires: joinKey ? joinWindowEnd(window) : null};
    }

    // Copies the code shown in the share dialog (a new one if it has expired)
    async _copySharedRoom(){
        const modalEl = document.getElementById(Modals.ROOM.SHARE_ROOM);
        const copyBtn = modalEl.querySelector('[data-field="copy_btn"]');

        if (!this._share) return;
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
                validityEl.textContent = "Not usable yet — this room is not connected to the server";
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

    async _leaveRoom(roomId){
        this._db.cleanRoom(roomId);
        this._db.removeRoom(roomId);
    }

    async sendFile() {
        const input = document.getElementById("ct_img_input");
        if (input.files.length === 0) return;

        const file = await this.limitToHD(input.files[0]);
        input.value = ""; // the same file can be chosen again

        // Type and size of the image that is sent (after scaling), shown in the bubble
        const content = JSON.stringify({type: file.type, size: file.size});
        await this._sendFileMessage(file, Message.TYPE_IMAGE, await this._aes.encryptPadded(content, this._roomKey));
    }

    // Any file (PDF, Word, ...). Name and size are sent encrypted in the message content,
    // so the bubble can show them before the file itself is downloaded.
    async sendDocument() {
        const input = document.getElementById("ct_doc_input");
        if (input.files.length === 0) return;

        const file = input.files[0];
        input.value = "";

        const content = JSON.stringify({name: file.name.slice(0, 200), size: file.size});
        await this._sendFileMessage(file, Message.TYPE_FILE, await this._aes.encryptPadded(content, this._roomKey));
    }

    // Encrypts the file, stores it locally and sends the message plus the file chunks
    async _sendFileMessage(file, type, content) {
        // Sizes of the encrypted (padded) data — that is what is sent
        const blob = await this._aes.encryptFile(file, this._roomKey);
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

        const msg = new Message({
            id: crypto.randomUUID(),
            roomId: this._roomId,
            alias: await this._aes.encryptPadded(this._alias, this._roomKey),
            aliasId: await this._aes.encryptPadded(this._aliasId, this._roomKey),
            content: content,
            timestamp: Date.now(),
            type: type,
            synced: false,
            chunkSize: CHUNK_SIZE,
            chunksTotal: totalChunks,
            ttl: this._messageTTL(),
            store: this._roomStore
        });

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

    // Loads the document (from the device or the server), decrypts it and saves it under its
    // original name. The browser shows its usual download; on iPhone it opens the preview,
    // from where it can be saved to Files or opened in Word, a PDF viewer, ...
    async _downloadDocument(fileId) {
        // Documents can be much larger than images — give the download more time
        const file = await this.getOrRequestFile(fileId, 120 * 1000);
        const blob = await this._aes.decryptFileBlob(file.blob, file.mimeType, this._roomKey);

        let name = "document";
        const row = await this._db.getMessage(fileId);
        if (row?.content) {
            try {
                name = JSON.parse(await this._aes.decrypt(row.content, this._roomKey)).name || name;
            } catch { /* keep the generic name */ }
        }

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

        console.log(`File is not in DB present requesting file ${fileId}`);

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
            console.warn('Image decode failed, sending original:', file.type, e);
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

        let timeStamp = new Date();

        let msg = new Message({
            id: crypto.randomUUID(),
            roomId: this._roomId,
            alias: await this._aes.encryptPadded(this._alias, this._roomKey),
            aliasId: await this._aes.encryptPadded(this._aliasId, this._roomKey),
            content: await this._aes.encryptPadded(msgRaw, this._roomKey),
            timestamp: timeStamp.getTime(),
            type: Message.TYPE_TEXT,
            synced: false,
            ttl: this._messageTTL(),
            store: this._roomStore
        });

        document.getElementById("ct_msg_input").value = "";

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
            .catch(err => console.error("Marking room as read failed:", err));
    }

    async _renderMessage(msg) {
        if (msg.alias === undefined || msg.isExpired()) {
            return;
        }

        console.log("Rendering message", msg);

        const alias = await this._aes.decrypt(msg.alias, this._roomKey);
        const aliasId = await this._aes.decrypt(msg.aliasId, this._roomKey);

        let content;

        // Text, or the {type, size} info of images and documents (older images have no content)
        if (msg.content) {
            content = await this._aes.decrypt(msg.content, this._roomKey);
        }

        const isOwn    = aliasId === this._aliasId;
        const bubble   = msg._renderBubble(content);
        const status   = isOwn ? msg._renderStatus() : '';
        const title    = !isOwn
            ? `<div class="title alias-color" style="--alias-hue: ${idHue(aliasId)}" alias-id="${msg._escape(aliasId)}">${msg._escape(alias)}</div>`
            : '';

        // Already shown (e.g. a message from the WebSocket arrived while the room was loading)
        if (document.getElementById(msg.id)) return;

        document.getElementById('ct_room').insertAdjacentHTML('beforeend', `
        <div class="message-item${isOwn ? ' user' : ''}">
            <div id="${msg.id}" class="content">
                ${title}
                <div class="bubble text-line-break">${bubble}</div>
                <div class="footer">${msg.formattedTime} ${this._ttlHTML(msg)} ${status}</div>
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
        content.closest('.message-item').remove();

        // Remove date dividers that have no messages left
        document.querySelectorAll('#ct_room .message-divider').forEach(divider => {
            const next = divider.nextElementSibling;
            if (!next || next.classList.contains('message-divider')) divider.remove();
        });
    }

    // Room TTL under the room name, e.g. "⏱ max 1 h"
    // Header line under the room name: maximum lifetime and whether messages are kept on the server
    _renderRoomInfo() {
        const el = document.getElementById('ro_room_ttl');
        if (!el) return;

        const store = this._roomStore
            ? `<span class="room-store" title="Keep on Server: messages are kept encrypted on the server"><ion-icon name="cloud-done-outline"></ion-icon> server</span>`
            : `<span class="room-store" title="Keep on Server is off: only members who are online receive messages"><ion-icon name="cloud-offline-outline"></ion-icon> live only</span>`;

        el.innerHTML = `<ion-icon name="timer-outline"></ion-icon> max ${formatTTL(this._effectiveRoomTTL())}${store}`;
    }


    async showImageModal(file) {
        const blob = await this._aes.decryptFileBlob(file.blob, file.mimeType, this._roomKey);
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

    // Shares the image of the image modal (CHAT.SHARE_IMAGE); downloads it where the browser
    // cannot share files (desktop).
    _shareImage() {
        const file = this._shareFile;
        if (!file) return;

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).catch(err => {
                if (err.name !== 'AbortError') console.error('Share failed:', err);
            });
            return;
        }

        const a = document.createElement('a');
        a.href = this._shareUrl;
        a.download = file.name;
        a.click();
    }
}

// File name with the extension of the image type, e.g. "chatbit-image.png"
function imageFileName(mimeType) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
                  'image/heic': 'heic', 'image/heif': 'heif' }[mimeType] || 'jpg';
    return `chatbit-image.${ext}`;
}
