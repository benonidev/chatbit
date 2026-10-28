import {Events} from "./event.js";
import {logger} from "./log.js";

const log = logger("push");

// Web push: once the WebSocket is ready it asks for notification permission, subscribes
// with the server VAPID key and sends the subscription to the server (Events.WS.SUBSCRIBE_PUSH).
export class Push {
    constructor(events) {
        this._events = events;
    }

    async init() {
        this._events.on(Events.WS.READY, async ()=> {
            await this.subscribe();
        });
    }

    async subscribe(){
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            log.info("push is not supported by this browser");
            return;
        }

        let permission = await Notification.requestPermission();

        if (permission !== 'granted') {
            permission = Notification.permission;
        }

        if (permission !== 'granted') {
            log.info("notification permission denied");
            return;
        }

        let swRegistration = await navigator.serviceWorker.getRegistration();
        if (!swRegistration) {
            log.warn("no service worker registration found");
            return;
        }
        let pushManager = swRegistration.pushManager;
        if (!this.isPushManagerActive(pushManager)) {
            return;
        }

        let subscriptionOptions = {
            userVisibleOnly: true,
            applicationServerKey: this.urlBase64ToUint8Array(this._vapidPublicKey())
        };

        try {
            let subscription = await pushManager.subscribe(subscriptionOptions);

            this._events.emit(Events.WS.SUBSCRIBE_PUSH, {endpoint: subscription.endpoint,
                p256dh: this.arrayBufferToBase64url(subscription.getKey('p256dh')),
                auth: this.arrayBufferToBase64url(subscription.getKey('auth'))})
            log.info("subscribed");

            // Here you can send fetch request with subscription data to your backend API for next push sends from there
        } catch (error) {
            log.warn("subscribing failed:", error);
        }
    }

    async unsubscribe() {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) return;

        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) return;

        await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint })
        });

        await subscription.unsubscribe();
        log.info("unsubscribed");
    }

    arrayBufferToBase64url(buffer) {
        return btoa(String.fromCharCode(...new Uint8Array(buffer)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    isPushManagerActive(pushManager) {
        if (!pushManager) {
            if (!window.navigator.standalone) {
                document.getElementById('add-to-home-screen').style.display = 'block';
            } else {
                throw new Error('PushManager is not active');
            }
            document.getElementById('subscribe_btn').style.display = 'none';
            return false;
        } else {
            return true;
        }
    }

    // The server renders its VAPID public key into <meta name="vapid-public-key"> of index.html.
    _vapidPublicKey() {
        const key = document.querySelector('meta[name="vapid-public-key"]')?.content;
        if (!key) throw new Error('VAPID public key is missing in index.html');
        return key;
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
    }

}