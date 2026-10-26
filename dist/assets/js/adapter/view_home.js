import {Events} from "./event.js";
import {Pages} from "./page.js";
import {Room} from "../domain/room.js";
import {Notifications} from "./notification.js";
import {Modals} from "./modal.js";
import {InviteCode, InviteError} from "./invite.js";
import {idHue} from "./color.js";

// Home page: room list, creating new rooms and joining rooms via invite code or QR code.
class ViewHome {
    constructor(events, aes, keyStore, db, qrScanner) {
        this._events = events;
        this._db = db;
        this._aes = aes;   // AESAdapter instance
        this._keyStore = keyStore;
        this._qrScanner = qrScanner;
        this._invite = new InviteCode(aes);
        this._roomListRender = 0; // incremented per showRooms() call
        this._pendingJoins = new Set();  // rooms joined with an invite code, waiting for the server
        this._rejectedRooms = new Set(); // rooms the server rejected — warned once per session
        this._rejectedJoins = new Set(); // invite joins rejected before the room was opened
    }

    init() {
        console.log("View Home init");

        // room_info only comes after an accepted join
        this._events.on(Events.WS.ROOM_INFO, (info) => {
            this._pendingJoins.delete(info.id);
            this._rejectedRooms.delete(info.id);
        });

        this._events.on(Events.WS.JOIN_REJECTED, async (info) => {
            await this._joinRejected(info.id);
        });

        // Keep the unread badges up to date while the room list is visible. Debounced, because
        // after a reconnect the missed messages arrive in a burst.
        const refreshBadges = () => {
            if (!this._onHomePage) return;
            clearTimeout(this._badgeTimer);
            this._badgeTimer = setTimeout(() => this._updateUnreadBadges(), 300);
        };
        this._events.on(Events.CHAT.MESSAGE_STORED, refreshBadges);
        this._events.on(Events.CHAT.MESSAGES_EXPIRED, refreshBadges);
        this._events.on(Events.CHAT.ROOM_CLEANED, refreshBadges);

        this._events.on(Events.PROFILE.OPEN, async () => {
            const profile = await this._db.getProfile();
            document.getElementById("in_settings_alias").value = profile.name ?? "";
        });

        this._events.on(Events.PROFILE.SAVE, async () => {
            await this._saveProfile();
        });

        this._events.on(Events.APP.UPDATE, () => {
            this._updateApp().catch(err => {
                console.error("App update failed:", err);
                this._events.emit(Notifications.DANGER, {header: "Update", msg: "Update check failed. Are you online?"});
            });
        });

        this._events.on(Events.STATE.PAGE, async (pageName) => {
            // Safety net: never keep the camera running after the page changed
            this._qrScanner.Stop();

            this._onHomePage = pageName === Pages.HOME;

            if (pageName === Pages.HOME) {
                await this._showAlias();

                const version = document.querySelector('meta[name="app-version"]')?.content;
                const versionEl = document.getElementById("in_app_version");
                if (versionEl && version) versionEl.textContent = version;

                console.log("View Home Page");

                await this.showRooms();
            }
        });

        this._events.on(Events.ROOM.NEW_ROOM_MODAL, async (msg) => {
            console.log("New Room Modal");
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.NEW_ROOM);
        });

        this._events.on(Events.ROOM.JOIN_ROOM_MODAL, async (msg) => {
            console.log("Join Room Modal");
            // The scanner starts the camera when the modal is shown and stops it when it is hidden
            this._qrScanner.Start((code) => this._joinRoomByScan(code));
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.JOIN_ROOM);

        });

        this._events.on(Events.ROOM.NEW_ROOM, async (msg) => {
            console.log("Add Room");
            this.addRoom().catch(err => console.error('addRoom failed:', err));
            this._events.emit(Events.MODAL.CLOSE, Modals.HOME.NEW_ROOM);
            // todo catch error
        });

        this._events.on(Events.ROOM.JOIN_ROOM, async (msg) => {
            console.log("join Room");
            await this._joinRoomByPaste()
            // todo catch error
        });
    }

    async _joinRoomByPaste() {
        const modalEl = document.getElementById(Modals.HOME.JOIN_ROOM);

        const inviteCodeField = modalEl.querySelector('textarea[name="invite_code"]');
        const inviteCodePinField = modalEl.querySelector('input[name="invite_code_pin"]');

        const code = inviteCodeField.value.trim();
        if (!code) return;

        const invite = await this._decodeInvite(code, inviteCodePinField.value);
        if (!invite) return;

        inviteCodeField.value = "";
        inviteCodePinField.value = "";

        await this._joinRoom(invite);
    }

    // A scanned QR code. A PIN protected code is put into the invite code field,
    // so the user only has to enter the PIN and press "Join by Code".
    async _joinRoomByScan(code) {
        if (this._invite.needsPin(code)) {
            const modalEl = document.getElementById(Modals.HOME.JOIN_ROOM);
            modalEl.querySelector('textarea[name="invite_code"]').value = code;
            modalEl.querySelector('input[name="invite_code_pin"]').focus();
            this._events.emit(Notifications.WARNING, {
                header: "The invite code is protected",
                msg: "Please enter the PIN and press Join by Code",
            });
            return;
        }

        const invite = await this._decodeInvite(code, "");
        if (invite) await this._joinRoom(invite);
    }

    // Returns {i, n, k} or null after showing what is wrong with the code.
    async _decodeInvite(code, pin) {
        try {
            return await this._invite.decode(code, pin);
        } catch (err) {
            if (err instanceof InviteError && err.reason === "pin") {
                this._events.emit(Notifications.WARNING, {
                    header: "The invite code is protected",
                    msg: pin ? "The PIN is not correct for this invite code" : "Please enter the PIN of the invite code",
                });
            } else {
                console.error("Invalid invite code:", err);
                this._events.emit(Notifications.DANGER, {
                    header: "The invite code is not valid",
                    msg: "Please use the invite code or QR code of a ChatBit room",
                });
            }
            return null;
        }
    }

    // invite: {i: roomId, n: roomName, k: base64 room key}
    async _joinRoom(roomObj) {

        const joinRoom = new Room({
            id: roomObj.i,
            name: await this._aes.encrypt(roomObj.n, this._keyStore.getMasterKey()),
            key: await this._aes.encrypt(roomObj.k, this._keyStore.getMasterKey()),
            pushNotifications: true,
            store: true,
            ttl: 0
        })

        try {
            await this._db.addRoom(joinRoom);
            this._pendingJoins.add(joinRoom.id);
            this._rejectedJoins.delete(joinRoom.id); // left over from a rejection after the room was opened
            // The invite code lets the server accept this join once, for a few minutes
            this._events.emit(Events.WS.JOIN_ROOM, {id: joinRoom.id, notification: true, inviteCode: roomObj.c || undefined});
        } catch (err) {
            // Room was joined before — just open it
            if (err.name !== "ConstraintError") {
                console.error("Failed to join room:", err);
                return;
            }
        }

        // Close the modal completely before switching the page: the page change replaces the
        // modal HTML, and if that happens during the fade out, "hidden.bs.modal" never fires,
        // the camera keeps running and the backdrop stays.
        this._qrScanner.Stop();
        await this._closeJoinModal();

        // The server can answer during the fade out — a rejected room is gone already
        if (this._rejectedJoins.delete(joinRoom.id)) return;

        this._events.emit(Events.ROOM.OPEN_ROOM, joinRoom.id);
    }

    // The server did not accept the join code. A room that was just joined with an invite code
    // is removed again; for a known room (clock far off, or a room from before join codes) the
    // user is warned once.
    async _joinRejected(roomId) {
        if (this._pendingJoins.delete(roomId)) {
            this._rejectedJoins.add(roomId);
            await this._db.removeRoom(roomId);
            this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
            this._events.emit(Notifications.DANGER, {
                header: "The invite code is not valid anymore",
                msg: "It has expired or was used already. Please ask for a new invite code.",
            });
            return;
        }

        if (this._rejectedRooms.has(roomId)) return;
        this._rejectedRooms.add(roomId);

        this._events.emit(Notifications.WARNING, {
            header: "The server did not let you into a room",
            msg: "Check the date and time of this device. If the room is older, ask a member for a new invite code.",
        });
    }

    // Hides the join modal and resolves once the fade out is finished.
    _closeJoinModal() {
        const modalEl = document.getElementById(Modals.HOME.JOIN_ROOM);
        if (!modalEl || !modalEl.classList.contains("show")) return Promise.resolve();

        return new Promise(resolve => {
            // Fallback in case the event never fires
            const timer = setTimeout(resolve, 1000);
            modalEl.addEventListener("hidden.bs.modal", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });

            this._events.emit(Events.MODAL.CLOSE, Modals.HOME.JOIN_ROOM);
        });
    }

    async addRoom() {
        const newRoom = new Room({
            id: crypto.randomUUID(),
            name: await this._aes.encrypt(document.getElementById("in_new_room_name").value, this._keyStore.getMasterKey()),
            key: await this._aes.encrypt(await this._aes.exportKey(await this._aes.generateKey()), this._keyStore.getMasterKey()),
            pushNotifications: document.getElementById("in_new_room_push").checked,
            store: document.getElementById("in_new_room_store").checked,
            ttl: document.getElementById("in_new_room_ttl").value * document.getElementById("in_new_room_ttl_unit").value
        })

        // send join room request to server over WS
        // TTL and store are only taken by the server when it creates the room — they can not be changed later
        this._events.emit(Events.WS.JOIN_ROOM, {id: newRoom.id, notification: newRoom.pushNotifications, ttl: newRoom.ttl, store: newRoom.store});

        // store new room in the database
        await this._db.addRoom(newRoom);

        this._cleanNewRoomForm();

        this._events.emit(Events.STATE.ROOM, newRoom.id);
    }

    _cleanNewRoomForm() {
        document.getElementById("in_new_room_name").value = "";
        document.getElementById("in_new_room_push").checked = false;
        document.getElementById("in_new_room_ttl").value = 0;
        document.getElementById("in_new_room_ttl_unit").value = 0;

        bootstrap.Modal.getInstance(document.getElementById("in_new_room"))?.hide();
    }

    // Alias in the profile box of the menu
    async _showAlias() {
        const el = document.getElementById("in_alias");
        if (!el) return;
        const profile = await this._db.getProfile();
        el.textContent = profile.name ?? "";
    }

    // New alias: used for the messages sent from now on (sent messages keep the old one)
    async _saveProfile() {
        const name = document.getElementById("in_settings_alias").value.trim();
        if (!name) {
            this._events.emit(Notifications.WARNING, {header: "Profile", msg: "The alias must not be empty."});
            return;
        }

        await this._db.updateProfileName(name);
        await this._showAlias();

        bootstrap.Modal.getInstance(document.getElementById("in_user_settings"))?.hide();
        this._events.emit(Notifications.INFO, {header: "Profile", msg: "Alias saved."});
    }

    // Looks for a new service worker version; if there is one, waits until it is active
    // and reloads the page with it.
    async _updateApp() {
        const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
        if (!reg) {
            location.reload();
            return;
        }

        this._events.emit(Notifications.INFO, {header: "Update", msg: "Checking for a new version..."});
        await reg.update();

        const sw = reg.installing || reg.waiting;
        if (!sw) {
            this._events.emit(Notifications.INFO, {header: "Update", msg: "ChatBit is up to date."});
            return;
        }

        await new Promise(resolve => {
            const done = () => sw.state === "activated" || sw.state === "redundant";
            if (done()) return resolve();
            sw.addEventListener("statechange", () => { if (done()) resolve(); });
            // A worker that waits for old tabs to close is activated right away
            if (sw.state === "installed") sw.postMessage({type: "SKIP_WAITING"});
        });

        location.reload();
    }

    // -------------------------------------------------------------------------
    // HTML rendering
    // -------------------------------------------------------------------------

    // Builds the whole list first and replaces it in one step: decrypting is async, and two
    // overlapping calls (e.g. fast page changes) would otherwise both append their rooms.
    async showRooms() {
        const render = ++this._roomListRender;
        const rooms = await this._db.getRooms();

        let html = "";
        for (const room of rooms) {
            const name = await this._aes.decrypt(room.name, this._keyStore.getMasterKey());
            html += `
                <li>
                    <a href="#" data-action="room:open_room" data-body="${room.id}" class="item col">
                        <div class="icon-box room-color" style="--room-hue: ${idHue(room.id)}">
                            <ion-icon name="chatbubble-ellipses-outline" class="md hydrated"></ion-icon>
                        </div>
                        <div class="in">
                            <div>${escapeHTML(name)}</div>
                        </div>
                        <span class="badge badge-danger unread-badge" data-unread-room="${room.id}" hidden></span>
                    </a>
                </li>`;
        }

        if (render !== this._roomListRender) return; // a newer call renders the list
        const list = document.getElementById('id_room_list');
        if (!list) return; // page changed meanwhile
        list.innerHTML = html;

        await this._updateUnreadBadges(rooms);
    }

    // Shows the number of unread messages next to every room ("99+" above 99)
    async _updateUnreadBadges(rooms) {
        rooms = rooms ?? await this._db.getRooms();

        for (const room of rooms) {
            const badge = document.querySelector(`[data-unread-room="${room.id}"]`);
            if (!badge) continue;

            const count = await this._db.countUnread(room.id, room.lastRead);
            badge.textContent = count > 99 ? "99+" : String(count);
            badge.hidden = count === 0;
        }
    }
}
// The room name comes from the invite code of another user — never insert it as HTML
function escapeHTML(str) {
    const el = document.createElement("div");
    el.textContent = str ?? "";
    return el.innerHTML;
}

export default ViewHome