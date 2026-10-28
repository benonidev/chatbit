import {Events} from "./event.js";

// Opens and closes Bootstrap modals in response to Events.MODAL.OPEN / CLOSE (body: modal id).
export class Modal {
    constructor(events) {
        this._events = events;
    }

    async init() {
        this._events.on(Events.MODAL.OPEN, async (modalId) => {
            await this.openModal(modalId);
        });

        this._events.on(Events.MODAL.CLOSE, async (modalId) => {
            await this.closeModal(modalId);
        });

        // Bootstrap sets aria-hidden on a closing modal while the clicked button still has the
        // focus — the browser blocks that (and warns). Drop the focus first, for every modal
        // (also the ones created by ViewApproval or closed with data-bs-dismiss).
        document.addEventListener("hide.bs.modal", (e) => {
            if (e.target.contains(document.activeElement)) document.activeElement.blur();
        });
    }

    async openModal(modalId){
        const modalEl = document.getElementById(modalId);
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
    }

    async closeModal(modalId){
        const modalEl = document.getElementById(modalId);
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.hide();
    }
}


export const Modals = {
    ROOM: {
        SHARE_ROOM: "modal:room:share_room",
        EDIT_ROOM: "modal:room:edit_room",
        LEAVE_ROOM: "modal:room:leave_room",
        CLEAN_ROOM: "modal:room:clean_room",
        MEMBERS: "modal:room:members",
        MESSAGE: "modal:room:message",
        HISTORY: "modal:room:history",
        SECURITY: "modal:room:security",
    },
    HOME: {
        JOIN_ROOM: "modal:home:join_room",
        NEW_ROOM: "modal:room:new_room",
        CLEAN_IMAGES: "modal:home:clean_images",
        DELETE_ALL: "modal:home:delete_all",
        UPDATE: "modal:home:update",
    },
};