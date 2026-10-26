import {Events} from "./event.js";

// Minutes of inactivity until the app logs off, "0" (or nothing stored) means never
export const LOGOFF_KEY = "ChatbitLogoffMinutes";
export const LOGOFF_STEPS = [0, 30, 2 * 60, 6 * 60, 12 * 60];

// How often the inactivity is checked
const CHECK_MS = 30 * 1000;

// Interactions that count as activity
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];

export function readLogoffMinutes() {
    try {
        const minutes = Number(localStorage.getItem(LOGOFF_KEY));
        return LOGOFF_STEPS.includes(minutes) ? minutes : 0;
    } catch {
        return 0; // private mode: no timer
    }
}

// Logs the user off after the configured time without interaction: the key store is locked
// and the page reloads, so no decrypted message stays in memory and the lock screen is shown.
// Uses wall clock time, so the time the PWA spent in the background counts as inactivity.
export class LogoffTimer {
    constructor(events, keyStore) {
        this._events = events;
        this._keyStore = keyStore;
        this._lastActivity = Date.now();
    }

    init() {
        const touch = () => { this._lastActivity = Date.now(); };
        ACTIVITY_EVENTS.forEach(name =>
            document.addEventListener(name, touch, {capture: true, passive: true}));

        // The inactive time starts with the unlock, not with the start of the app
        this._events.on(Events.STATE.UNLOCK, touch);

        setInterval(() => this.check(), CHECK_MS);

        // Timers are paused while the PWA is in the background — check before anything is visible
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") this.check();
        });
    }

    check() {
        const minutes = readLogoffMinutes();
        if (minutes === 0 || !this._keyStore.isUnlocked()) return;
        if (Date.now() - this._lastActivity < minutes * 60 * 1000) return;

        console.log(`Logoff after ${minutes} min without activity`);
        this._keyStore.lock();
        location.reload(); // key store is empty → lock screen
    }
}
