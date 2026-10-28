import {Events} from "./event.js";
import {Pages} from "./page.js";
import {Notifications} from "./notification.js";

// Lock screen: shows the alias and unlocks the key store with the password.
export class ViewLock {
    constructor(events, keyStore, db) {
        this._events = events;
        this._db   = db;
        this._keyStore = keyStore;
    }

    init() {
        this._events.on(Events.LOCK.UNLOCK, (form) => this.unlock(form));
        this._events.on(Events.LOCK.CLEAR, () => this.clear());

        this._events.on(Events.STATE.PAGE, async (pageName) => {
            if(pageName === Pages.LOCK){
                await this.setAliasName();
            }
        });
    }

    async setAliasName(){
        const profile = await this._db.getProfile();
        document.getElementById('ls_alias').textContent = profile.name;
    }

    async unlock(form){
        const password = form.querySelector('#ls_password').value;

        const ok = await this._keyStore.unlock(password);
        if (!ok) {
            this._events.emit(Notifications.DANGER, {header: "Unlock", subtitle: "Password incorrect...", msg: "Please try it again.", time: 5000});
            form.querySelector('#ls_password').value = "";
        } else {
            await this._unlockEvent();
        }
    }

    async clear() {
        this._keyStore.lock();
        await this._db.clear();

        this._events.emit(Events.CHANGE.PAGE, Pages.LOGIN);
    }

    async _unlockEvent(){
        const profile = await this._db.getProfile();

        this._events.emit(Events.STATE.UNLOCK, profile);

        this._events.emit(Events.CHANGE.PAGE, Pages.HOME);
    }

}