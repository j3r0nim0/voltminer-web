/* The deliberate reversal of anti-pwa.js, which unregistered every service
   worker and wiped every cache on load because the old design could not
   tolerate a stale copy of the page. This one installs the app instead: sw.js
   makes staleness impossible (network-first navigations, updateViaCache
   'none'), so offline caching and an install button are safe to offer. */
(() => {
  'use strict';

  const VERSION = '72';
  const $ = (id) => document.getElementById(id);
  const supportsSW = 'serviceWorker' in navigator;
  const secureContext = location.protocol === 'https:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  // --- standalone detection --------------------------------------------
  const standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);

  if (standalone) document.documentElement.classList.add('is-standalone');
  const voltPWA = {
    version: VERSION,
    standalone,
    swControlled: supportsSW && !!navigator.serviceWorker.controller,
  };
  window.voltPWA = voltPWA;
  let reloading = false; // guards the post-update reload to exactly one call

  // --- update banner ----------------------------------------------------
  const showUpdate = () => {
    const banner = $('sw-update');
    if (banner) banner.hidden = false;
  };
  // A waiting worker only matters when we already have a controller — i.e.
  // this is an update, not the very first install.
  const checkWaiting = (reg) => {
    if (reg && reg.waiting && navigator.serviceWorker.controller) showUpdate();
  };
  const watchInstalling = (reg) => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdate();
      }
    });
  };

  // --- install affordances ---------------------------------------------
  let deferredPrompt = null;
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Third-party engines on iOS (Chrome/Firefox/Edge/Opera/Google app) cannot
  // install a PWA, so their only path is to reopen the page in Safari.
  const isIOSSafari =
    isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent);
  const setupInstall = () => {
    const install = $('install');
    if (standalone || !install) return; // already installed: stay hidden
    const btn = $('install-btn');

    if (btn) {
      btn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          try {
            await deferredPrompt.userChoice;
          } catch (_) {
            /* prompt dismissed or unavailable — fall through to hide */
          }
          install.hidden = true;
          return;
        }
        if (isIOSSafari) {
          const ios = $('install-ios');
          if (ios) ios.hidden = false; // Safari: reveal the share-sheet steps
        }
      });
    }

    if (isIOS && isIOSSafari) {
      install.hidden = false;
      if (btn) {
        // Prefer a supplied label, then existing DOM copy, only then a
        // fallback string — never invent copy when the DOM already has it.
        btn.textContent =
          btn.getAttribute('data-ios-label') || btn.textContent.trim() || 'Get the app';
      }
    } else if (isIOS) {
      const alt = $('install-ios-alt');
      if (alt) alt.hidden = false;
    }
    // Non-iOS, non-Chromium browsers never fire beforeinstallprompt, so
    // #install stays hidden for them throughout.
  };

  // --- Chromium install prompt ------------------------------------------
  // Registered at script evaluation, not on load: Chrome can fire
  // beforeinstallprompt before the load event, and a listener attached on load
  // would miss it and the button would never appear. The script tag sits at the
  // end of <body>, so the elements it touches already exist.
  if (!standalone) {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); // defer the mini-infobar; our button drives it
      deferredPrompt = event;
      const install = $('install');
      if (install) install.hidden = false;
    });

    window.addEventListener('appinstalled', () => {
      const install = $('install');
      if (install) install.hidden = true;
      deferredPrompt = null;
    });
  }

  // --- registration -----------------------------------------------------
  window.addEventListener('load', () => {
    setupInstall();

    if (!supportsSW || !secureContext) return;
    try {
      navigator.serviceWorker
        .register('./sw.js', { scope: './', updateViaCache: 'none' })
        .then((reg) => {
          watchInstalling(reg);
          checkWaiting(reg);
          reg.update().catch(() => {}); // at most one probe per load

          navigator.serviceWorker.addEventListener('controllerchange', () => {
            voltPWA.swControlled = true;
            if (reloading) {
              reloading = false;
              location.reload(); // exactly once, then this context is gone
            }
          });

          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') checkWaiting(reg);
          });

          const updateBtn = $('sw-update-btn');
          if (updateBtn) {
            updateBtn.addEventListener('click', () => {
              const target = reg.waiting || reg.active;
              if (!target) return;
              reloading = true;
              target.postMessage({ type: 'SKIP_WAITING' });
            });
          }
        })
        .catch(() => {});
    } catch (_) {
      /* registration must never break the page */
    }
  });
})();
