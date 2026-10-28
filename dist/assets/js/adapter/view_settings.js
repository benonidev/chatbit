import {Events} from "./event.js";
import {Notifications} from "./notification.js";
import {Modals} from "./modal.js";
import {MIN_PASSWORD_LENGTH} from "./key_store.js";
import {formatBytes} from "../domain/file.js";
import {LOGOFF_KEY, readLogoffMinutes} from "./logoff.js";
import {logger} from "./log.js";

const log = logger("settings");

// Same key as the dark mode handling in base.js ("1" dark, "0" light)
const DARK_MODE_KEY = "ChatbitDarkMode";

// Settings modal of the home page: change password, light/dark mode, storage usage with
// image clean up and information about the running app.
export class ViewSettings {
    constructor(events, keyStore, db, ws) {
        this._events = events;
        this._keyStore = keyStore;
        this._db = db;
        this._ws = ws;
    }

    init() {
        this._events.on(Events.SETTINGS.OPEN, async () => {
            this._fillDarkMode();
            this._fillLogoff();
            this._fillInfo();
            await this._fillStorage();
        });

        this._events.on(Events.SETTINGS.CHANGE_PASSWORD, async () => {
            await this._changePassword();
        });

        this._events.on(Events.SETTINGS.DARK_MODE, (el) => {
            this._setDarkMode(el.checked);
        });

        this._events.on(Events.SETTINGS.LOGOFF_TIMER, (el) => {
            this._setLogoff(el.value);
        });

        // Confirmation dialogs in the same style as "Leave Room"
        this._events.on(Events.SETTINGS.CLEAN_IMAGES_ASK, () => {
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.CLEAN_IMAGES);
        });

        this._events.on(Events.SETTINGS.DELETE_ALL_ASK, () => {
            this._events.emit(Events.MODAL.OPEN, Modals.HOME.DELETE_ALL);
        });

        this._events.on(Events.SETTINGS.CLEAN_IMAGES, async () => {
            await this._cleanImages();
        });

        this._events.on(Events.SETTINGS.DELETE_ALL, async () => {
            await this._deleteAll();
        });
    }

    // -------------------------------------------------------------------------
    // Password
    // -------------------------------------------------------------------------

    async _changePassword() {
        const current = document.getElementById("in_settings_pw_current");
        const next = document.getElementById("in_settings_pw_new");
        const repeat = document.getElementById("in_settings_pw_repeat");

        if (next.value.length < MIN_PASSWORD_LENGTH) {
            this._notify(Notifications.WARNING, `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (next.value !== repeat.value) {
            this._notify(Notifications.WARNING, "The new passwords do not match.");
            return;
        }

        let ok;
        try {
            ok = await this._keyStore.changePassword(current.value, next.value);
        } catch (err) {
            log.error("changing the password failed:", err);
            this._notify(Notifications.DANGER, "Changing the password failed, the old password is still valid.");
            return;
        }
        if (!ok) {
            this._notify(Notifications.DANGER, "The current password is wrong.");
            return;
        }

        current.value = next.value = repeat.value = "";
        this._notify(Notifications.INFO, "Password changed.");
    }

    // -------------------------------------------------------------------------
    // Light / dark mode
    // -------------------------------------------------------------------------

    _fillDarkMode() {
        const el = document.getElementById("in_settings_dark");
        if (el) el.checked = document.body.classList.contains("dark-mode-active");
    }

    _setDarkMode(dark) {
        document.body.classList.toggle("dark-mode-active", dark);
        window.applyThemeColor?.(); // base.js: browser bar color
        try {
            localStorage.setItem(DARK_MODE_KEY, dark ? "1" : "0");
        } catch {
            // private mode: the choice only lasts until the app is closed
        }
    }

    // -------------------------------------------------------------------------
    // Logoff timer (see logoff.js)
    // -------------------------------------------------------------------------

    _fillLogoff() {
        const el = document.getElementById("in_settings_logoff");
        if (el) el.value = String(readLogoffMinutes());
    }

    _setLogoff(minutes) {
        try {
            localStorage.setItem(LOGOFF_KEY, minutes);
        } catch {
            this._notify(Notifications.WARNING, "The logoff timer can not be saved in this browser.");
        }
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    async _fillStorage() {
        const stats = await this._db.storageStats();
        this._setField("storage_messages", `${stats.messages} in ${stats.rooms} rooms`);
        this._setField("storage_images", `${stats.files} (${formatBytes(stats.fileBytes)})`);

        // Everything of this origin: database, service worker cache, ...
        let total = "unknown";
        if (navigator.storage?.estimate) {
            const {usage, quota} = await navigator.storage.estimate();
            total = `${formatBytes(usage)} of ${formatBytes(quota)}`;
        }
        this._setField("storage_total", total);

        let persisted = "unknown";
        if (navigator.storage?.persisted) {
            persisted = await navigator.storage.persisted() ? "yes" : "no — the browser may delete the data when space is low";
        }
        this._setField("storage_persisted", persisted);
    }

    async _cleanImages() {
        const count = await this._db.deleteFiles();
        await this._fillStorage();
        this._notify(Notifications.INFO, `${count} files deleted.`);
    }

    // -------------------------------------------------------------------------
    // Delete everything
    // -------------------------------------------------------------------------

    // Leaves all rooms on the server, ends push notifications, deletes the profile, rooms,
    // keys, messages and images and starts again with the login page.
    async _deleteAll() {
        // Leave the rooms, so the server stops sending messages and push notifications
        const rooms = await this._db.getRooms();
        if (rooms.length > 0 && this._ws.isOpen()) {
            this._ws.leaveRooms({rooms: rooms.map(r => r.id)});
            await this._waitUntilSent();
        }

        try {
            const reg = await navigator.serviceWorker?.getRegistration();
            const sub = await reg?.pushManager?.getSubscription();
            await sub?.unsubscribe();
        } catch (err) {
            log.warn("removing the push subscription failed:", err);
        }

        await this._db.clear();
        this._keyStore.lock();
        try {
            localStorage.removeItem(DARK_MODE_KEY);
            localStorage.removeItem(LOGOFF_KEY);
        } catch {
            // nothing stored
        }

        location.reload(); // no profile any more → login page
    }

    // Waits (max. 2 s) until the WebSocket has sent its buffer — a reload would drop it
    async _waitUntilSent() {
        const conn = this._ws.conn;
        for (let i = 0; i < 20 && conn?.bufferedAmount > 0; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        await new Promise(r => setTimeout(r, 200)); // give the frame time to leave the device
    }

    // -------------------------------------------------------------------------
    // Info
    // -------------------------------------------------------------------------

    _fillInfo() {
        // "<version> · <commit> · <build date>", see index.html
        const [version, commit, buildDate] = (document.querySelector('meta[name="app-version"]')?.content ?? "")
            .split(" · ");
        this._setField("info_version", version || "unknown");
        this._setField("info_commit", commit || "unknown");
        this._setField("info_build", buildDate ? new Date(buildDate).toLocaleString() : "unknown");
        // Hash over every file of the app (chatbit -asset-hash) — compare with the GitHub release
        const hash = (document.querySelector('meta[name="app-hash"]')?.content ?? "").toUpperCase();
        this._setField("info_hash", hash ? hash.slice(0, 16).match(/.{4}/g).join(" ") : "unknown");
        this._setField("info_server", this._ws.isOpen() ? "connected" : "not connected");
        this._setField("info_push", "Notification" in window ? window.Notification.permission : "not supported");
        this._setField("info_sw", navigator.serviceWorker?.controller ? "active" : "not active");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    _setField(name, text) {
        const el = document.querySelector(`#in_app_settings [data-field="${name}"]`);
        if (el) el.textContent = text;
    }

    _notify(type, msg) {
        this._events.emit(type, {header: "Settings", msg});
    }
}
