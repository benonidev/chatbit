import {Events} from "./event.js";

// Shows in-app notification banners at the top of the page.
// Emit one of the Notifications events with {header, subtitle?, msg, time?};
// time is in ms (values < 100 are treated as seconds), default 3000.
export class Notification {
    constructor(events) {
        this._events = events;
    }

    async init() {
        this._events.on(Notifications.INFO, (data) => {
            this._notification("info", data.header, data.subtitle, data.msg, data.time);
        });
        this._events.on(Notifications.DANGER, (data) => {
            this._notification("danger", data.header, data.subtitle, data.msg, data.time);
        });
        this._events.on(Notifications.WARNING, (data) => {
            this._notification("warning", data.header, data.subtitle, data.msg, data.time);
        });
        this._events.on(Notifications.PRIMARY, (data) => {
            this._notification("primary", data.header, data.subtitle, data.msg, data.time);
        });
    }

    _notification(type, title, subtitle, msg, time) {
        // Not in #appHeader: a page change replaces the header and would remove a notification
        // that was just shown (e.g. a rejected join that sends the user back home)
        const container = document.body;

        if (!time) time = 3000;

        // Close and remove previous notifications
        const existingBoxes = container.querySelectorAll(".notification-box");
        existingBoxes.forEach((el) => {
            el.classList.remove("show");
            setTimeout(() => el.remove(), 300);
        });

        const template = document.createElement("template");
        template.innerHTML = `
            <div class="notification-box">
                <div class="notification-dialog ios-style bg-${type}">
                    <div class="notification-header">
                        <strong data-field="title"></strong>
                        <div class="right">
                            <button type="button" class="close-button" aria-label="Close">
                                <ion-icon name="close-circle"></ion-icon>
                            </button>
                        </div>
                    </div>
                    <div class="notification-content">
                        <div class="in">
                            <h3 class="subtitle" data-field="subtitle"></h3>
                            <div class="text" data-field="msg"></div>
                        </div>
                    </div>
                </div>
            </div>
        `.trim();

        const notificationBox = template.content.firstElementChild;

        // textContent: the texts can contain room names and aliases of other users
        notificationBox.querySelector('[data-field="title"]').textContent = title || "";
        notificationBox.querySelector('[data-field="msg"]').textContent = msg || "";
        const subtitleEl = notificationBox.querySelector('[data-field="subtitle"]');
        if (subtitle) subtitleEl.textContent = subtitle;
        else subtitleEl.remove();
        container.appendChild(notificationBox);

        let autoCloseTimeout = null;

        const closeNotification = () => {
            if (autoCloseTimeout) {
                clearTimeout(autoCloseTimeout);
                autoCloseTimeout = null;
            }
            notificationBox.classList.remove("show");
            setTimeout(() => {
                if (notificationBox.parentElement) {
                    notificationBox.remove();
                }
            }, 300);
        };

        const closeButton = notificationBox.querySelector(".close-button");
        if (closeButton) {
            closeButton.addEventListener("click", (e) => {
                e.preventDefault();
                closeNotification();
            });
        }

        const dialog = notificationBox.querySelector(".notification-dialog");
        if (dialog) {
            dialog.addEventListener("click", (e) => {
                if (!e.target.closest(".close-button")) {
                    closeNotification();
                }
            });
        }

        // Fade the notification in
        setTimeout(() => {
            notificationBox.classList.add("show");
        }, 50);

        // Remove it again after x seconds / milliseconds
        if (time) {
            const duration = time < 100 ? time * 1000 : time;
            autoCloseTimeout = setTimeout(() => {
                closeNotification();
            }, duration);
        }
    }
}


export const Notifications = {
    INFO: "notification:info",
    DANGER: "notification:danger",
    WARNING: "notification:warning",
    PRIMARY: "notification:primary"
};