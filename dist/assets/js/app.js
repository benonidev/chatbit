import {EventBus, Events} from './adapter/event.js';
import {AesAdapter} from './adapter/aes.js';
import {DatabaseAdapter} from './adapter/database.js';
import {WebSocketAdapter} from './adapter/websocket.js';
import {KeyStore, MIN_PASSWORD_LENGTH} from './adapter/key_store.js';
import {Page, Pages} from './adapter/page.js';
import {ViewLock} from "./adapter/view_lock.js";
import ViewHome from "./adapter/view_home.js";
import {ViewRoom} from "./adapter/view_room.js";
import {QRScanner} from "./adapter/scanner.js";
import {Modal} from "./adapter/modal.js";
import {Notification, Notifications} from "./adapter/notification.js";
import {Push} from "./adapter/push.js";
import {Expiry} from "./adapter/expiry.js";
import {ViewSettings} from "./adapter/view_settings.js";
import {LogoffTimer} from "./adapter/logoff.js";
import {RoomKeys} from "./adapter/room_keys.js";
import {ViewApproval} from "./adapter/view_approval.js";
import {logger} from "./adapter/log.js";

const log = logger("app");

// Composition root: creates all adapters and views, wires them to one shared
// EventBus and decides which page is shown on startup (login, lock or home).
export class App {
    constructor() {
        this.events = new EventBus();
        this.aes = new AesAdapter();
        this.db = new DatabaseAdapter(this.aes, this.events);
        this.keyStore = new KeyStore(this.aes, this.db, this.events);
        this.ws = new WebSocketAdapter(this.events, this.db, this.keyStore);
        this.roomKeys = new RoomKeys(this.events, this.db, this.keyStore, this.aes);
        this.db.setMessageFilter(msg => this.roomKeys.acceptMessage(msg));
        this.page = new Page(this.events);
        this.viewLock = new ViewLock(this.events, this.keyStore, this.db);
        this.viewHome = new ViewHome(this.events, this.aes, this.keyStore, this.db, new QRScanner(), this.roomKeys);
        this.viewRoom = new ViewRoom(this.events, this.aes, this.keyStore, this.db, this.roomKeys);
        this.viewApproval = new ViewApproval(this.events);
        this.modal = new Modal(this.events);
        this.notification = new Notification(this.events);
        this.push = new Push(this.events);
        this.expiry = new Expiry(this.events, this.db);
        this.viewSettings = new ViewSettings(this.events, this.keyStore, this.db, this.ws);
        this.logoffTimer = new LogoffTimer(this.events, this.keyStore);
    }

    async init() {
        log.info("start", document.querySelector('meta[name="app-version"]')?.content || "dev");
        await this.db.init();
        await this.page.init();
        this.keyStore.init();
        this.ws.init();
        this.roomKeys.init();
        this.viewApproval.init();
        this.viewLock.init();
        this.viewHome.init();
        await this.viewRoom.init();
        await this.modal.init();
        await this.notification.init();
        await this.push.init();
        this.expiry.init();
        this.viewSettings.init();
        this.logoffTimer.init();

        await this._checkIsUserLoggedIn();

        this._activateListener();

    }

    _activateListener() {
        this.events.on(Events.APP.REGISTER, (form) => this.register(form));

        document.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;

            log.debug("action", btn.dataset.action);

            this.events.emit(btn.dataset.action, btn.dataset.body);
        })

        // No form is ever sent to the server (the CSP forbids it as well): a form with a
        // data-submit attribute forwards itself to the event bus
        document.addEventListener("submit", (e) => {
            e.preventDefault();
            const form = e.target.closest("[data-submit]");
            if (!form) return;

            this.events.emit(form.dataset.submit, form);
        });

        // Global change listener: forwards every element with a data-change attribute to the event bus
        document.addEventListener("change", (e) => {
            const target = e.target.closest("[data-change]");
            if (!target) return;

            this.events.emit(target.dataset.change, target);
        });
    }

    async _checkIsUserLoggedIn() {
        const page = ""

        if (!this.keyStore.isUnlocked()) {
            if (!await this.db.isInitialized()) {
                log.info("no profile yet, showing the registration");
                this.events.emit(Events.CHANGE.PAGE, Pages.LOGIN);
            } else {
                log.debug("profile is locked, showing the lock screen");
                this.events.emit(Events.CHANGE.PAGE, Pages.LOCK);
                $("#ls_alias").text("TODO");
            }
        } else {
            this.events.emit(Events.CHANGE.PAGE, Pages.HOME);
        }
    }

    async register(form) {
        log.info("registering a new profile");

        const password = form.querySelector('#lo_password').value;
        const alias = form.querySelector('#lo_alias').value.trim();

        if (!alias) {
            this.events.emit(Notifications.WARNING, {header: "Register", msg: "Please choose an alias."});
            return;
        }
        // The password protects all room keys on this device — PBKDF2 alone does not save a short one
        if (password.length < MIN_PASSWORD_LENGTH) {
            this.events.emit(Notifications.WARNING, {header: "Register", msg: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`});
            return;
        }

        await this.keyStore.register(alias, password);


        await this._unlockEvent();
    }


    async _unlockEvent() {
        const profile = await this.db.getProfile();

        this.events.emit(Events.STATE.UNLOCK, profile);

        this.events.emit(Events.CHANGE.PAGE, Pages.HOME);
    }
}