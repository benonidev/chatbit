import {Events} from "./event.js";
import {logger} from "./log.js";

const log = logger("expiry");

// The only shorter TTLs a message can have (same as MessageTTLSteps on the server): a freely
// chosen TTL is visible to the server and would mark all messages of one person.
export const MESSAGE_TTL_STEPS = [5 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60];

// Largest step that is not longer than ttl (at least the smallest), like the server rounds it
export function snapTTL(ttl) {
    return MESSAGE_TTL_STEPS.filter(s => s <= ttl).pop() ?? MESSAGE_TTL_STEPS[0];
}

// How often expired messages are removed and the remaining times in the chat are updated
const TICK_MS = 60 * 1000;

// Short human readable duration: "30 d", "5 h", "12 min", "<1 min"
export function formatDuration(seconds) {
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
    return "<1 min";
}

// Exact TTL setting in the largest unit that divides it evenly: "90 min", "2 h", "7 d"
export function formatTTL(seconds) {
    const unit = [[86400, "d"], [3600, "h"], [60, "min"]].find(([u]) => seconds >= u && seconds % u === 0);
    return unit ? `${seconds / unit[0]} ${unit[1]}` : formatDuration(seconds);
}

// Deletes expired messages (and their image files) from the local database.
// Runs every minute, when the app comes back to the foreground and after every reconnect.
// Emits CHAT.MESSAGES_EXPIRED with the deleted messages and CHAT.TICK, so the views can
// remove them and update the remaining times.
export class Expiry {
    constructor(events, db) {
        this._events = events;
        this._db = db;
        this._timer = null;
        this._running = false;
    }

    init() {
        this._timer = setInterval(() => this.tick(), TICK_MS);

        // Timers are paused while the PWA is in the background — catch up when it is visible again
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") this.tick();
        });
        this._events.on(Events.WS.CONNECTED, () => this.tick());

        this.tick();
    }

    async tick() {
        if (this._running) return; // a slow purge must not overlap with the next one
        this._running = true;

        try {
            const expired = await this._db.purgeExpired();
            if (expired.length > 0) {
                this._events.emit(Events.CHAT.MESSAGES_EXPIRED, expired);
            }
        } catch (err) {
            log.error("removing expired messages failed:", err);
        } finally {
            this._running = false;
        }

        this._events.emit(Events.CHAT.TICK, Date.now());
    }
}
