/* Experimental miner: do not persist a service worker. Cached mine.js was
   serving a duplicate #consent id and Start always failed. Mining needs a
   live network anyway (bridge WebSocket). */
(() => {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  }).catch(() => {});
  if (window.caches && caches.keys) {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
  }
  try { localStorage.removeItem('voltminer.web.sw'); } catch { /* ignore */ }
})();
