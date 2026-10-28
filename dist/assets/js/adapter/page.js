import {Events} from "./event.js";

// Single page navigation: on Events.CHANGE.PAGE it loads assets/view/<page>_header.html and
// <page>_content.html into the layout and then emits Events.STATE.PAGE so the view can render.
export class Page {
    constructor(events) {
        this._events = events;
        this._loading = 0; // incremented per page change — an older, slower load is dropped
    }

    async init() {
        this._events.on(Events.CHANGE.PAGE, async (pageName) => {
            await this.setPage(pageName);
        });
    }


    async setPage(pageName){
        const loading = ++this._loading;
        window.history.pushState({}, "", "/" + pageName);

        const responseHeader = await fetch("assets/view/" + pageName + "_header.html");
        const htmlStringHeader = await responseHeader.text()

        const responseContent = await fetch("assets/view/" + pageName + "_content.html");
        const htmlStringContent = await responseContent.text()

        // A newer page change was started meanwhile (e.g. a double tap)
        if (loading !== this._loading) return;

        document.getElementById('appContent').innerHTML = htmlStringContent;
        document.getElementById('appHeader').innerHTML = htmlStringHeader;

        this._events.emit(Events.STATE.PAGE, pageName);
    }

}


export const Pages = {
    LOGIN: "login",
    ROOM: "room",
    LOCK: "lockscreen",
    HOME: "home",
};