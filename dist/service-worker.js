//--------------------------------------------------------------------------
// You can find dozens of practical, detailed, and working examples of 
// service worker usage on https://github.com/mozilla/serviceworker-cookbook
//--------------------------------------------------------------------------

// Injected by Go server at startup — changes with every build (version, commit and build date,
// so a local build of the same commit is an update as well). Without a build date the server
// uses its start time.
var CACHE_VERSION = '{{.Version}}-{{printf "%.7s" .Commit}}-{{.BuildDate}}';

var CACHE_NAME = 'chatbit-v' + CACHE_VERSION;

// Files
var ASSETS_TO_CACHE = [
  'index.html',
  'manifest.json',
  'assets/css/style.css',
  'assets/css/inc/bootstrap/bootstrap.min.css',
  'assets/css/inc/bootstrap/bootstrap-icons.min.css',
  'assets/css/inc/bootstrap/fonts/bootstrap-icons.woff',
  'assets/css/inc/bootstrap/fonts/bootstrap-icons.woff2',
  'assets/css/inc/splide/splide.min.css',
  'assets/css/inc/inter/inter.css',
  'assets/css/inc/inter/inter-latin-400-normal.woff2',
  'assets/css/inc/inter/inter-latin-ext-400-normal.woff2',
  'assets/css/inc/inter/inter-latin-500-normal.woff2',
  'assets/css/inc/inter/inter-latin-ext-500-normal.woff2',
  'assets/css/inc/inter/inter-latin-700-normal.woff2',
  'assets/css/inc/inter/inter-latin-ext-700-normal.woff2',
  'assets/js/lib/jquery-3.7.0.min.js',
  'assets/js/lib/dexie.min.js',
  'assets/js/lib/qrcode.min.js',
  'assets/js/lib/zxing/barcode-detector-3.0.8.min.js',
  'assets/js/lib/zxing/zxing_reader-2.2.4.wasm',
  'assets/js/lib/bootstrap.min.js',
  'assets/js/plugins/splide/splide.min.js',
  'assets/js/base.js',
  'assets/js/index.js',
  'assets/js/app.js',
  'assets/js/adapter/aes.js',
  'assets/js/adapter/database.js',
  'assets/js/adapter/event.js',
  'assets/js/adapter/expiry.js',
  'assets/js/adapter/view_settings.js',
  'assets/js/adapter/color.js',
  'assets/js/lib/ionicons-5.5.2/ionicons.esm.js',
  'assets/js/adapter/invite.js',
  'assets/js/adapter/join_code.js',
  'assets/js/adapter/key_store.js',
  'assets/js/adapter/log.js',
  'assets/js/adapter/logoff.js',
  'assets/js/adapter/modal.js',
  'assets/js/adapter/notification.js',
  'assets/js/adapter/page.js',
  'assets/js/adapter/push.js',
  'assets/js/adapter/scanner.js',
  'assets/js/adapter/view_home.js',
  'assets/js/adapter/view_lock.js',
  'assets/js/adapter/view_room.js',
  'assets/js/adapter/view_approval.js',
  'assets/js/adapter/room_crypto.js',
  'assets/js/adapter/room_keys.js',
  'assets/js/lib/crypto-bundle.js',
  'assets/js/adapter/websocket.js',
  'assets/js/domain/file.js',
  'assets/js/domain/message.js',
  'assets/js/domain/profile.js',
  'assets/js/domain/room.js',
  'assets/view/home_content.html',
  'assets/view/home_header.html',
  'assets/view/lockscreen_content.html',
  'assets/view/lockscreen_header.html',
  'assets/view/login_content.html',
  'assets/view/login_header.html',
  'assets/view/room_content.html',
  'assets/view/room_header.html',
  'assets/img/LogoBenoni.svg',
  'assets/img/LogoBenoniLight.svg'
];

const IGNORED_PATHS = ['/api/', '/ws/', '/version.json']; // version.json: always the one of the server

const IS_LOCALHOST =
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1';

/* =========================
   INSTALL
========================= */
self.addEventListener('install', event => {
    if (IS_LOCALHOST) {
        self.skipWaiting();
        return;
    }

    event.waitUntil(
        caches.open(CACHE_NAME)
            // cache: 'reload' bypasses the browser HTTP cache. Otherwise files the browser still
            // holds as "fresh" (cached before the server sent no-cache) end up in the new cache
            // and the update only half arrives.
            .then(cache => cache.addAll(ASSETS_TO_CACHE.map(url => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())  // activate immediately, don't wait for tab close
    );
});

/* =========================
   ACTIVATE
========================= */
self.addEventListener('activate', event => {
    if (IS_LOCALHOST) {
        return;
    }

    event.waitUntil(
        caches.keys()
            .then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== CACHE_NAME)
                        .map(key => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())   // take control of all open tabs
            .then(() => notifyClients())        // tell the app: new version is live
    );
});

// Manual update from the menu: activate a waiting version immediately
self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function notifyClients() {
    return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
    });
}

/* =========================
   FETCH
========================= */
self.addEventListener('fetch', event => {
    const { request } = event;

    /* 🚫 Dev mode: always use the network */
    if (IS_LOCALHOST) {
        return;
    }

    const url = new URL(event.request.url);

    /* 🚫 Non-HTTP schemes (e.g. chrome-extension://) */
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return;
    }

    /* 🚫 Never cache API requests */
    if (IGNORED_PATHS.some(path => url.pathname.startsWith(path))) {
        return;
    }

    /* 🧭 SPA-Navigation → index.html */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => caches.match('/index.html'))
        );
        return;
    }

    /* 📦 Assets: Cache First */
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) {
                return cached;
            }

            // no-cache: revalidate with the server, never take a stale file from the HTTP cache
            return fetch(request, { cache: 'no-cache' }).then(response => {
                if (!response || response.status !== 200) {
                    return response;
                }

                const responseClone = response.clone();
                const requestUrl = new URL(request.url);
                if (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') {
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, responseClone);
                    });
                }

                return response;
            });
        })
    );
});


self.addEventListener('push', (event) => {
    // PushData keys structure standart https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification
    let pushData = event.data.json();
    if (!pushData || !pushData.title) {
        console.warn('[sw] push without title');
    }
    self.registration.showNotification(pushData.title, pushData)
        .then(() => {
            // You can save to your analytics fact that push was shown
            // fetch('https://your_backend_server.com/track_show?message_id=' + pushData.data.message_id);
        });
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    if (!event.notification.data) {
        console.warn('[sw] notification click without data')
        return;
    }
    if (!event.notification.data.url) {
        console.warn('[sw] notification click without url')
        return;
    }

    clients.openWindow(event.notification.data.url)
        .then(() => {
            // You can send fetch request to your analytics API fact that push was clicked
            // fetch('https://your_backend_server.com/track_click?message_id=' + pushData.data.message_id);
        });
});


/*

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',        // App Icon
      badge: '/badge.png',          // Kleines Icon in Statusleiste
      image: '/preview.png',        // Grosses Bild (optional)
      tag: 'message',               // Gruppiert Notifications
      renotify: true,               // vibrate again even if the tag is the same
      data: { url: data.url }       // for the click handler
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const chatUrl = event.notification.data.url; // z.B. "/chat/123"

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // PWA already open? → focus it and navigate
        for (const client of clientList) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            return client.navigate(chatUrl);
          }
        }
        // PWA not open → open a new window
        return clients.openWindow(chatUrl);
      })
  );
});




self.addEventListener("push", (event) => {

    //let data = { title: "Push", body: "New message", url: "/" };
    //try { if (event.data) data = { ...data, ...event.data.json() }; } catch { console.error("Push data is not valid JSON")}
    const data = event.data.json();
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: "/assets/img/favicon.png",
            badge: "/assets/img/favicon.png",
            data: { url: "/" },
            vibrate: [200, 100, 200],
            requireInteraction: true,
            silent: false
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then((clientList) => {
            // Vergleich entfernt — einfach erstes Fenster fokussieren
            if (clientList.length > 0) {
                return clientList[0].focus();
            }
            // No window open — open a new one
            return clients.openWindow('/');
        })
    );
});

 */