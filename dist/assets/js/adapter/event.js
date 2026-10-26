// Minimal publish/subscribe bus — all adapters and views talk to each other only through it.
// Event names are defined in Events below.
export class EventBus {
    constructor() {
        this._listeners = {};
    }

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    }

    emit(event, data) {
        console.log("Emit event " + event + " with data " + data);
        this._listeners[event]?.forEach(cb => cb(data));
    }

    off(event, callback) {
        this._listeners[event] = this._listeners[event]
            ?.filter(cb => cb !== callback);
    }
}

export const Events = {
    WS: {
        SEND_MESSAGE: 'ws:send_message',
        RECEIVED_MESSAGE: 'ws:received_message',
        RECEIVED_FILE: 'ws:received_file',

        TRANSFER_REQUEST: 'ws:transfer_request',
        TRANSFER_DONE: 'ws:transfer_done',

        JOIN_ROOM: 'ws:join_room',
        LEAVE_ROOM: 'ws:leave_room',
        CLEAN_ROOM: 'ws:clean_room', // body: room id — deletes the messages and files of the room on the server and on all members
        ROOM_CLEANED: 'ws:room_cleaned', // body: {id, timestamp} — another member cleaned the room
        SUBSCRIBE_PUSH: 'ws:subscribe_push',
        ROOM_INFO: 'ws:room_info', // body: {id, ttl, store, joinSecret} — the TTL and store setting the server enforces for the room
        JOIN_REJECTED: 'ws:join_rejected', // body: {id, reason} — the join code was missing, wrong, expired or used
        CONNECTED: 'ws:connected', // emitted after every (re)connect, once all rooms are joined again
        READY: 'ws:ready' // emitted once after the first successful connection
    },
    CHAT: {
        MESSAGE: 'chat:message',  // todo
        SEND_MESSAGE: 'chat:send_message',
        SEND_FILE: 'chat:send_file',
        SYNCED: 'chat:synced',

        OPEN_IMAGE: 'chat:open_image',
        SEND_DOCUMENT: 'chat:send_document', // body: the file input (data-change)
        OPEN_FILE: 'chat:open_file',         // body: message id — downloads the document
        SHARE_IMAGE: 'chat:share_image', // shares the image open in the image modal

        SHARE_ACTIVE_ROOM: 'chat:share_active_room',
        EDIT_ACTIVE_ROOM: 'chat:edit_active_room',
        UPDATE_ACTIVE_ROOM: 'chat:update_active_room',
        LEAVE_ACTIVE_ROOM: 'chat:leave_active_room',
        LEAVE_ACTIVE_ROOM_ASK: 'chat:leave_active_room_ask',
        CLEAN_ACTIVE_ROOM: 'chat:clean_active_room',             // deletes the messages on this device
        CLEAN_ACTIVE_ROOM_SERVER: 'chat:clean_active_room_server', // on this device, the server and all members
        ROOM_CLEANED: 'chat:room_cleaned',                         // body: room id — local messages deleted by ROOM_CLEANED
        CLEAN_ACTIVE_ROOM_ASK: 'chat:clean_active_room_ask',       // opens the confirmation dialog
        COPY_ACTIVE_ROOM: 'chat:copy_active_room',
        RENEW_SHARE_CODE: 'chat:renew_share_code', // new invite code in the share dialog

        MESSAGE_STORED: 'chat:message_stored',     // body: Message — a received message was saved in the database
        MESSAGES_EXPIRED: 'chat:messages_expired', // body: [{id, roomId}] removed from the database
        TICK: 'chat:tick',                         // every minute — update the remaining times
    },
    ROOM: {
        NEW_ROOM: 'room:new_room',
        NEW_ROOM_MODAL: 'room:new_room_modal', // this will open the modal to join a room
        JOIN_ROOM_MODAL: 'room:join_room_modal', // this will open the modal to join a room
        JOIN_ROOM: 'room:join_room', // no body read from modal
        EDIT_ROOM: 'room:edit_room', // todo
        LEAVE_ROOM: 'room:leave_room', // todo
        OPEN_ROOM: 'room:open_room' // body: room_id
    },
    // This is the event to prepare the content of the page
    STATE: {
        ROOM: 'state:room',
        PAGE: 'state:page',
        USER: 'state:user',
        UNLOCK: 'state:unlock',
    },
    // CHANGE.PAGE will just load the Html Pages
    CHANGE: {
        PAGE: 'change:page',
    },
    PROFILE: {
        OPEN: 'profile:open', // fills the profile modal
        SAVE: 'profile:save', // saves the alias from the profile modal
    },
    SETTINGS: {
        OPEN: 'settings:open',                       // fills the settings modal
        CHANGE_PASSWORD: 'settings:change_password', // reads the password fields of the modal
        DARK_MODE: 'settings:dark_mode',             // body: the switch element (data-change)
        LOGOFF_TIMER: 'settings:logoff_timer',       // body: the select element (data-change)
        CLEAN_IMAGES_ASK: 'settings:clean_images_ask', // opens the confirmation dialog
        CLEAN_IMAGES: 'settings:clean_images',       // deletes all locally stored images
        DELETE_ALL_ASK: 'settings:delete_all_ask',   // opens the confirmation dialog
        DELETE_ALL: 'settings:delete_all',           // leaves all rooms and deletes every local data
    },
    APP: {
        UPDATE: 'app:update', // checks for a new service worker version and reloads with it
    },
    // CHANGE.PAGE will just load the Html Pages
    MODAL: {
        OPEN: 'modal:open',  // body: modal_id
        CLOSE: 'modal:close',  // body: modal_id
    }
};