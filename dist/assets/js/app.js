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

// Composition root: creates all adapters and views, wires them to one shared
// EventBus and decides which page is shown on startup (login, lock or home).
export class App {
    constructor() {
        this.events = new EventBus();
        this.aes = new AesAdapter();
        this.db = new DatabaseAdapter(this.aes, this.events);
        this.keyStore = new KeyStore(this.aes, this.db, this.events);
        this.ws = new WebSocketAdapter(this.events, this.db, this.keyStore);
        this.page = new Page(this.events);
        this.viewLock = new ViewLock(this.events, this.keyStore, this.db);
        this.viewHome = new ViewHome(this.events, this.aes, this.keyStore, this.db, new QRScanner());
        this.viewRoom = new ViewRoom(this.events, this.aes, this.keyStore, this.db);
        this.modal = new Modal(this.events);
        this.notification = new Notification(this.events);
        this.push = new Push(this.events);
        this.expiry = new Expiry(this.events, this.db);
        this.viewSettings = new ViewSettings(this.events, this.keyStore, this.db, this.ws);
        this.logoffTimer = new LogoffTimer(this.events, this.keyStore);
    }

    async init() {
        console.log("App init");
        await this.db.init();
        await this.page.init();
        this.keyStore.init();
        this.ws.init();
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
        console.log("start event listener")

        document.addEventListener("click", (e) => {
            console.log("click event");

            const btn = e.target.closest("[data-action]");
            if (!btn) return;

            console.log("click", btn.dataset.action, btn.dataset.body);

            this.events.emit(btn.dataset.action, btn.dataset.body);
        })

        // Global change listener: forwards every element with a data-change attribute to the event bus
        document.addEventListener("change", (e) => {
            const target = e.target.closest("[data-change]");
            if (!target) return;

            this.events.emit(target.dataset.change, target);
        });
    }

    async _checkIsUserLoggedIn() {
        const page = ""

        console.log("Check if user is logged in");

        if (!this.keyStore.isUnlocked()) {
            console.log("database is locked");
            if (!await this.db.isInitialized()) {
                console.log("database is not initialized");
                this.events.emit(Events.CHANGE.PAGE, Pages.LOGIN);
            } else {
                console.log("database is not initialized");
                this.events.emit(Events.CHANGE.PAGE, Pages.LOCK);
                $("#ls_alias").text("TODO");
            }
        } else {
            this.events.emit(Events.CHANGE.PAGE, Pages.HOME);
        }
    }

    async register(form) {
        console.log("New Register");

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