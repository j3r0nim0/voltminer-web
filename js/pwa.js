/* Registers the service worker and surfaces an install prompt when the browser offers one.
   Classic script (no import.meta). Relative URLs so GitHub project Pages works. */
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* registration is best-effort — mining still works without it */
      });
    });
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.querySelectorAll('[data-pwa-install]').forEach((btn) => {
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice.catch(() => {});
        deferredPrompt = null;
        document.querySelectorAll('[data-pwa-install]').forEach((b) => { b.hidden = true; });
      }, { once: true });
    });
  });
})();
