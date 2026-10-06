/* The whole reason this site previously refused a service worker (see the
   now-retired anti-pwa.js) was stale-cache risk: a page pinned forever to an
   old copy of itself. This worker is built so that cannot happen. Navigations
   are network-first, so the HTML is never stale while online, and the worker
   registers with updateViaCache: 'none' so sw.js itself is never served from
   the HTTP cache. Sub-resources are stale-while-revalidate, which is safe
   because they are versioned by ?v=59. CSP-friendly: no eval, no
   importScripts, no third-party origins. */
'use strict';
const VERSION = '59';
const SHELL_CACHE = `vmw-shell-${VERSION}`;
const ASSETS_CACHE = `vmw-assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSETS_CACHE];
// Tolerated individually: one missing file must not fail the whole install,
// so we never use cache.addAll (which is all-or-nothing).
const PRECACHE = [
  './',
  './index.html',
  './diag.html',
  './notices.html',
  './manifest.webmanifest',
  './css/styles.css?v=59',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
// Never intercept these: the /stratum WebSocket upgrade, health probes, the
// worker itself and the manifest (the browser must reach the network for it).
const BYPASS = new Set([
  '/stratum',
  '/relay-health',
  '/health',
  '/sw.js',
  '/manifest.webmanifest',
]);
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] precache miss', url, err && err.message);
          }),
        ),
      ),
    ),
    // No skipWaiting() here on purpose: the page decides when to hand over,
    // so a live mining session is not interrupted mid-install.
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function offlineFallback() {
  // Served as HTML so the browser renders the message rather than dumping it.
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>VoltMiner offline</title>' +
      '<h1>Offline</h1><p>VoltMiner is offline and no cached copy is available. ' +
      'Reconnect and reload to continue mining.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function networkFirst(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // cache: 'no-store' — the online HTML must never come from the HTTP cache.
    return await fetch(request, { cache: 'no-store', signal: controller.signal });
  } catch (err) {
    // Return the cached document intact so its Content-Type stays text/html.
    // ignoreSearch matters: an installed app launches at `./?src=pwa`, whose
    // exact URL was never precached, so an offline launch would miss the shell
    // and land on the fallback page. Fall back to the exact page first, so
    // diag.html and notices.html also work offline.
    return (
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match('./')) ||
      (await caches.match('./index.html')) ||
      offlineFallback()
    );
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(event) {
  const cached = await caches.match(event.request);
  const revalidate = fetch(event.request).then((response) => {
    // Only cache clean, same-origin 200s. clone() before the response is used.
    if (response.ok && response.status === 200 && response.type === 'basic') {
      return caches
        .open(ASSETS_CACHE)
        .then((cache) => cache.put(event.request, response.clone()))
        .then(() => response);
    }
    return response;
  });
  if (cached) {
    // Serve the cache now; keep the worker alive long enough to refresh it.
    // waitUntil() is only legal during dispatch, and this runs after an await,
    // so a rejection here must not take the cached response down with it.
    try {
      event.waitUntil(revalidate.catch(() => {}));
    } catch { /* best effort: refresh on the next visit instead */ }
    return cached;
  }
  // Nothing cached: the network result is the response, errors propagate.
  return revalidate;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 1. Only GET is cacheable.
  if (request.method !== 'GET') return;
  // 2. Range requests must reach the network whole; slicing them corrupts media.
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  // 3. Same-origin only — never proxy anything cross-origin.
  if (url.origin !== self.location.origin) return;
  // 4. Explicit bypass (WebSocket upgrade, probes, sw.js, manifest).
  if (BYPASS.has(url.pathname)) return;

  // 5. Navigations: network-first, so HTML is never stale while online.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  // 6. Other same-origin sub-resources: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(event));
});
