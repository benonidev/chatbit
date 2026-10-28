import {Events} from "./event.js";
import {Pages} from "./page.js";
import {Notifications} from "./notification.js";
import {Modals} from "./modal.js";
import {InviteCode, InviteError} from "./invite.js";
import {idHue} from "./color.js";
import {logger} from "./log.js";

const log = logger("home");

// Home page: room list, creating new rooms and joining rooms via invite code or QR code.
class ViewHome {
    constructor(events, aes, keyStore, db, qrScanner, roomKeys) {
        this._events = events;
        this._db = db;
        this._aes = aes;   // AESAdapter instance
        this._keyStore = keyStore;
        this._roomKeys = roomKeys;
        this._qrScanner = qrScanner;
        this._invite = new InviteCode(aes);
        this._roomListRender = 0; // incremented per showRooms() call
        this._rejectedRooms = new Set(); // rooms the server rejected — warned once per session
        this._rejectedJoins = new Set(); // join requests rejected before the room was opened
    }

    init() {
        // room_info only comes after an accepted join
        this._events.on(Events.WS.ROOM_INFO, (info) => {
            this._rejectedRooms.delete(info.id);
        });

        this._events.on(Events.WS.JOIN_REJECTED, async (info) => {
            if (info.reason === "code" || info.reason === "declined") await this._joinRejected(info.id, info.reason);
        });

        // Approved, removed or deleted: the list shows the status
        this._events.on(Events.ROOM.CHANGED, () => {
            if (this._onHomePage) this.showRooms();
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
            this._checkUpdate().catch(err => {
                log.error("update check failed:", err);
                this._events.emit(Notifications.DANGER, {header: "Update", msg: "Update check failed. Are you online?"});
            });
        });

        this._events.on(Events.APP.UPDATE_CONFIRM, () => {
            this._updateApp().catch(err => {
                log.error("app update failed:", err);
                this._events.emit(Notifications.DANGER, {header: "Update", msg: "The update failed. Are you online?"});
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

                await this.showRooms();
            }
        });

        this._events.on(Events.ROOM.NEW_ROOM_MODAL, async (msg) => {
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.NEW_ROOM);
        });

        this._events.on(Events.ROOM.JOIN_ROOM_MODAL, async (msg) => {
            // The scanner starts the camera when the modal is shown and stops it when it is hidden
            this._qrScanner.Start((code) => this._joinRoomByScan(code));
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.JOIN_ROOM);

        });

        this._events.on(Events.ROOM.NEW_ROOM, async (msg) => {
            this.addRoom().catch(err => log.error("creating the room failed:", err));
            this._events.emit(Events.MODAL.CLOSE, Modals.HOME.NEW_ROOM);
            // todo catch error
        });

        this._events.on(Events.ROOM.JOIN_ROOM, async (msg) => {
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
            } else if (err instanceof InviteError && err.reason === "old") {
                this._events.emit(Notifications.DANGER, {
                    header: "Invite code of an older version",
                    msg: "Rooms of older versions do not exist anymore. Please ask for a new invite code.",
                });
            } else {
                log.warn("invalid invite code:", err.message);
                this._events.emit(Notifications.DANGER, {
                    header: "The invite code is not valid",
                    msg: "Please use the invite code or QR code of a ChatBit room",
                });
            }
            return null;
        }
    }

    // invite: {i, n, g, s, m, c} — sends the join request; the room waits for the approval of
    // the inviter. An existing room is just opened.
    async _joinRoom(invite) {
        try {
            await this._roomKeys.joinByInvite(invite);
        } catch (err) {
            log.error("joining the room failed:", err);
            return;
        }

        // Close the modal completely before switching the page: the page change replaces the
        // modal HTML, and if that happens during the fade out, "hidden.bs.modal" never fires,
        // the camera keeps running and the backdrop stays.
        this._qrScanner.Stop();
        await this._closeJoinModal();

        // The server can answer during the fade out — a rejected room is gone already
        if (this._rejectedJoins.delete(invite.i)) return;

        this._events.emit(Events.ROOM.OPEN_ROOM, invite.i);
    }

    // The server did not let the device in. A room that waits for approval is removed: the request
    // was declined, or the invite expired / was used / was not approved within 24 hours. For a
    // member room the user is warned once.
    async _joinRejected(roomId, reason) {
        log.warn("the server rejected the join code of a room");
        log.debug("rejected room", roomId);

        const room = await this._db.getRoom(roomId);
        if (!room) return;

        if (room.isPending()) {
            this._rejectedJoins.add(roomId);
            await this._roomKeys.deleteLocal(roomId);
            this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
            this._events.emit(Notifications.DANGER, reason === "declined" ? {
                header: "Join request declined",
                msg: `Your request to join "${await this._aes.decrypt(room.name, this._keyStore.getMasterKey())}" was declined.`,
                time: 10000,
            } : {
                header: "The invite is not valid anymore",
                msg: "It has expired, was used already, or was not approved within 24 hours. Please ask for a new invite code.",
            });
            return;
        }

        if (this._rejectedRooms.has(roomId)) return;
        this._rejectedRooms.add(roomId);

        this._events.emit(Notifications.WARNING, {
            header: "The server did not let you into a room",
            msg: "Check the date and time of this device. If it stays, ask a member for a new invite code.",
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

    // TTL and store are only taken by the server when it creates the room — they can not be changed later
    async addRoom() {
        const id = await this._roomKeys.createRoom({
            name: document.getElementById("in_new_room_name").value,
            pushNotifications: document.getElementById("in_new_room_push").checked,
            store: document.getElementById("in_new_room_store").checked,
            ttl: document.getElementById("in_new_room_ttl").value * document.getElementById("in_new_room_ttl_unit").value,
        });

        this._cleanNewRoomForm();

        this._events.emit(Events.STATE.ROOM, id);
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

    // New alias: only for rooms created or joined from now on — in a room the alias is fixed
    async _saveProfile() {
        const name = document.getElementById("in_settings_alias").value.trim();
        if (!name) {
            this._events.emit(Notifications.WARNING, {header: "Profile", msg: "The alias must not be empty."});
            return;
        }

        await this._db.updateProfileName(name);
        await this._showAlias();

        bootstrap.Modal.getInstance(document.getElementById("in_user_settings"))?.hide();
        this._events.emit(Notifications.INFO, {header: "Profile", msg: "Alias saved. It is used for new rooms — existing rooms keep your name."});
    }

    // Shows the installed version next to the one the server delivers now (version, commit, build
    // date, hash over all files) — the update only starts after "Update now"
    async _checkUpdate() {
        const [version, commit, buildDate] = (document.querySelector('meta[name="app-version"]')?.content ?? "").split(" · ");
        const installed = {version, commit, buildDate, assetHash: document.querySelector('meta[name="app-hash"]')?.content ?? ""};

        const res = await fetch("/version.json", {cache: "no-store"});
        if (!res.ok) throw new Error("version.json: " + res.status);
        const available = await res.json();

        // The meta tag has the short commit
        const same = available.assetHash === installed.assetHash && (available.commit ?? "").startsWith(installed.commit ?? "-");

        const modal = document.getElementById(Modals.HOME.UPDATE);
        const field = name => modal.querySelector(`[data-field="${name}"]`);
        field("title").textContent = same ? "ChatBit is up to date" : "New version available";
        field("installed").innerHTML = versionHTML(installed);
        field("available").innerHTML = versionHTML(available);
        field("confirm").hidden = same;
        field("cancel").textContent = same ? "CLOSE" : "CANCEL";

        this._events.emit(Events.MODAL.OPEN, Modals.HOME.UPDATE);
    }

    // Loads the new service worker version, waits until it is active and reloads the page with
    // it. Without a new worker (it was installed in the background already) a reload is enough.
    async _updateApp() {
        const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
        if (!reg) {
            location.reload();
            return;
        }

        this._events.emit(Notifications.INFO, {header: "Update", msg: "Loading the new version..."});
        await reg.update();

        const sw = reg.installing || reg.waiting;
        if (!sw) {
            location.reload();
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
            const status = room.isPending() ? `<div class="text-muted small">waiting for approval</div>`
                : room.isRemoved() ? `<div class="text-muted small">you are no member anymore</div>` : "";
            html += `
                <li>
                    <a href="#" data-action="room:open_room" data-body="${room.id}" class="item col">
                        <div class="icon-box room-color" style="--room-hue: ${idHue(room.id)}">
                            <ion-icon name="chatbubble-ellipses-outline" class="md hydrated"></ion-icon>
                        </div>
                        <div class="in">
                            <div>${escapeHTML(name)}${status}</div>
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

// "1.4.0 · a1b2c3d · 27.10.2026" plus the start of the hash; values come from the server — text only
function versionHTML(v) {
    const esc = text => {
        const el = document.createElement("div");
        el.textContent = text ?? "";
        return el.innerHTML;
    };
    const commit = (v.commit ?? "").slice(0, 7);
    const date = v.buildDate && !isNaN(new Date(v.buildDate)) ? new Date(v.buildDate).toLocaleString() : v.buildDate;
    const commitLink = /^[0-9a-f]{7,40}$/.test(commit)
        ? `<a href="https://github.com/benonich/chatbit/commit/${commit}" target="_blank" rel="noopener noreferrer"><code>${commit}</code></a>`
        : `<code>${esc(commit || "—")}</code>`;
    const hash = (v.assetHash ?? "").toUpperCase();
    return `<strong>${esc(v.version || "dev")}</strong> · ${commitLink}` +
        `<div class="small text-muted">${esc(date || "")}</div>` +
        `<div class="small">Hash <code>${esc(hash ? hash.slice(0, 16).match(/.{4}/g).join(" ") : "—")}</code></div>`;
}
