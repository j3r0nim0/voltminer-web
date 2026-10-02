/* VoltMiner PWA service worker — caches the app shell so the miner opens offline.
   Mining itself still needs a live WebSocket to the VPS bridge.
   Relative paths: GitHub project Pages is https://<user>.github.io/<repo>/ not /. */
const CACHE = 'voltminer-web-miner-v47';
const PRECACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/pwa.js',
  './js/mine.js',
  './js/miner-client.js',
  './js/miner-worker.js',
  './js/vendor/randomx/web-randomx.js',
  './js/vendor/randomx/web-randomx.wasm',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetched;
    })
  );
});
