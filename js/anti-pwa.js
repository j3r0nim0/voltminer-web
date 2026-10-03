/* No PWA, no service worker, no install prompt. This page must never be
   cached into a stale copy of itself, so any worker or cache left over from an
   earlier version is torn down on load. Moved out of index.html so the
   Content-Security-Policy can stay `script-src 'self'` with no inline script. */
(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((r) => r.forEach((x) => x.unregister())).catch(() => {});
  }
  if (window.caches && caches.keys) {
    caches.keys().then((k) => Promise.all(k.map((x) => caches.delete(x)))).catch(() => {});
  }
})();
