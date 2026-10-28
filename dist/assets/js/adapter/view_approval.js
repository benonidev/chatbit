import {Events} from "./event.js";

// Asks the inviter to approve a join request (RoomKeys emits ROOM.JOIN_REQUEST). The dialog is
// created here and not in a page template, so it shows on every page. Requests that come in
// while one is shown wait in a queue.
export class ViewApproval {
    constructor(events) {
        this._events = events;
        this._queue = [];
        this._showing = false;
    }

    init() {
        this._events.on(Events.ROOM.JOIN_REQUEST, (req) => {
            this._queue.push(req);
            this._next();
        });
    }

    _next() {
        if (this._showing || this._queue.length === 0) return;
        this._showing = true;

        const req = this._queue.shift();
        const el = document.createElement("div");
        el.className = "modal fade dialogbox";
        el.tabIndex = -1;
        el.setAttribute("data-bs-backdrop", "static");
        el.innerHTML = `
            <div class="modal-dialog" role="document">
                <div class="modal-content">
                    <div class="modal-header"><h5 class="modal-title">Join request</h5></div>
                    <div class="modal-body">
                        <p><strong data-field="alias"></strong> wants to join <strong data-field="room"></strong>.</p>
                        <p class="small">Fingerprint: <code data-field="fingerprint"></code><br>
                        It is shown on their phone while they wait — compare it before you accept.</p>
                    </div>
                    <div class="modal-footer">
                        <div class="btn-inline">
                            <a href="#" class="btn btn-text-secondary" data-choice="decline">DECLINE</a>
                            <a href="#" class="btn btn-text-primary" data-choice="accept">ACCEPT</a>
                        </div>
                    </div>
                </div>
            </div>`;

        // textContent: alias and room name come from other users
        el.querySelector('[data-field="alias"]').textContent = req.entry.alias || "Someone";
        el.querySelector('[data-field="room"]').textContent = req.roomName;
        el.querySelector('[data-field="fingerprint"]').textContent = req.fingerprint;

        const modal = new bootstrap.Modal(el);
        el.addEventListener("click", (e) => {
            const choice = e.target.closest("[data-choice]")?.dataset.choice;
            if (!choice) return;
            e.preventDefault();
            if (choice === "accept") this._events.emit(Events.ROOM.APPROVE, {roomId: req.roomId, entry: req.entry, request: req.request});
            if (choice === "decline") this._events.emit(Events.ROOM.DECLINE, {roomId: req.roomId, request: req.request});
            modal.hide();
        });
        el.addEventListener("hidden.bs.modal", () => {
            modal.dispose();
            el.remove();
            this._showing = false;
            this._next();
        }, {once: true});

        document.body.appendChild(el);
        modal.show();
    }
}
