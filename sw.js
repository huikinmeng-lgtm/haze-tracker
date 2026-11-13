/* Haze Tracker service worker: offline app shell, background checks, notification clicks. */
importScripts('shared.js');

const CACHE = 'haze-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'shared.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/badge-96.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

// App shell: stale-while-revalidate. NEA API calls are never cached (the page keeps the last reading itself).
self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (cached) {
        const network = fetch(req)
          .then(function (res) { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});

// Chrome on Android can wake an installed PWA periodically (not guaranteed, browser decides when).
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'haze-check') {
    event.waitUntil(Haze.checkAndNotify(self.registration).catch(function () {}));
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
