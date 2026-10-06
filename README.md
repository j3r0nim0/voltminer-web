# VoltMiner — Browser Experiment

Standalone RandomX web miner. RandomX runs in a Web Worker (WebAssembly) and shares go
straight to the visitor's own MoneroOcean wallet. **VoltMiner takes 0%** — no cut of the
hashrate, no redirected shares, no swapped payout address. The pool may charge its own fee.

```
browser Wasm worker  --WSS-->  origin-locked relay (our VPS)  --TLS-->  MoneroOcean stratum
```

Served from our own VPS (Caddy + the relay), not GitHub Pages — the pthread build needs
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` to reach
`crossOriginIsolated`, which a static Pages host cannot send.

## Behaviour

- Starts only when the visitor presses **Start** with a wallet and the consent box ticked.
- Login is `wallet+10000` (MoneroOcean difficulty suffix). The suffix is not a fee.
- One 2 GB RandomX dataset per origin, shared by 1–4 C++ pthreads; cached in OPFS between
  visits and rebuilt when the seed hash changes.
- Every solved share is re-hashed with the single-VM `_randomx_hash` before it is
  submitted (`verifySolved()` in `js/miner-worker.js`); a mismatch is dropped and logged
  rather than sent to the pool.
- Ships a service worker (`sw.js`), so it installs to the Home Screen on Android and
  iOS. This is the deliberate reversal of the old `js/anti-pwa.js`, which unregistered
  workers so the page could never serve a stale copy of itself. The guard moved into the
  worker instead: **navigations are network-first**, so while you are online the HTML is
  never stale, and a new worker is only activated when the visitor taps Reload.
- `diag.html` reports what the device actually supports — isolation, `SharedArrayBuffer`,
  service worker and cache state, OPFS, and a fixed RandomX reference vector hashed with
  whichever wasm build the device can run. iOS has no console, so this page is the test
  instrument.

## Install (PWA)

`manifest.webmanifest` + `sw.js` + `js/pwa.js` make the page an installable app:

- **Android / desktop Chromium** — the native `beforeinstallprompt` is captured and the
  install button appears only once the browser says installing is possible.
- **iOS** — Safari has no install API, so the page shows `Share → Add to Home Screen`
  instructions. A Home Screen app gets its own storage container, so the wallet is pasted
  once more, and it mines only while it is open in front of it.
- The CSP must allow the manifest or none of this works: `manifest-src 'self'` is set in
  `tools/server/Caddyfile` because `default-src 'none'` would otherwise block it.
- `sw.js` is served `no-store` — a service worker that can be pinned stale is a service
  worker that can never be fixed on an installed device.
- **Bump `VERSION` in `sw.js` (and the `?v=` on every script) on each deploy.** The worked
  example is `58`. The version string is what makes the worker detect its own update and
  what makes the offline shell re-precache instead of serving last deploy's HTML offline.
  `tools/deploy.sh` refuses to run if any script is on a different `?v=` than `sw.js`.

## Deploy

```bash
tools/deploy.sh --dry-run     # check and stage; change nothing
tools/deploy.sh               # push, verify, reload caddy if it changed
```

It aborts on the first failure, and the things it checks are the things that have already
gone wrong here by hand: a stale `?v=` on one script, the published C++ mirror drifting
from the C++ that was actually compiled, and a deploy nobody verified. Before pushing it
tars the current site to `/root/voltminer-web-backup-<timestamp>.tar.gz` and prints the
restore command, because verification happens after the push — and afterwards it runs
`sha256sum -c transparency/SHA256SUMS` **on the server** and aborts if any file disagrees
with what was published. Env overrides: `HOST`, `WEB_ROOT`, `SSH_KEY`.

The file list has one definition, `tools/served-tree.sh`, read by the deploy, the hash
generator and the version check. Nothing else knows which files the site contains, so the
published hashes cannot describe a different set of files than the one that got pushed.
`tools/gen-sha256sums.sh` regenerates the hashes on its own if you want them without
deploying; the sums file is deployed but never hashes itself.

## Layout

| Path | What |
|---|---|
| `index.html`, `notices.html`, `css/`, `icons/` | The site |
| `diag.html`, `js/diag.js` | On-device diagnostics report (no mining, no network) |
| `sw.js`, `manifest.webmanifest`, `js/pwa.js` | Installability: worker, manifest, install/update UI |
| `js/mine.js` | UI; `js/miner-client.js` stratum + lifecycle; `js/miner-worker.js` hashing |
| `js/vendor/randomx/*.{js,wasm}` | Committed builds (pthread + single-thread) |
| `third_party/WebRandomX-overlay/` | The C++ we compile; `build-web-randomx-mt.sh` rebuilds the wasm |
| `transparency/wasm-patch/` | Published copy of that C++, checked identical on every deploy |
| `tools/served-tree.sh` | The one definition of what the site serves |
| `tools/deploy.sh` | Push + verify + reload; run this rather than rsync by hand |
| `tools/gen-sha256sums.sh` | Regenerate `transparency/SHA256SUMS` from the served tree |
| `tools/web-stratum-bridge/` | The relay hop (see its own README) |
| `tools/rx-replay/` | Offline native-vs-Wasm hash reproduction (does not mine) |
| `tools/dev-server.mjs` | Static server with COOP/COEP for local work |


## Local preview

```bash
node tools/dev-server.mjs          # http://127.0.0.1:8099 (COOP/COEP on)
```

Without COOP/COEP the page falls back to the single-thread wasm and cache-only hashing.
The relay allows loopback origins, so a local page can still reach the real pool.
`127.0.0.1` counts as a secure context, so the service worker, the manifest and the
install prompt all work locally — check DevTools → Application → Service Workers.

## Licences

Site code is proprietary (© 2026 VoltMiner, all rights reserved). The bundled
WebAssembly is BSD-3-Clause (RandomX/WebRandomX: tevador, The Monero Project; SoftFloat:
the Regents of the University of California) and the Emscripten runtime is MIT/UIUC.
Full texts: `notices.html` and `js/vendor/randomx/NOTICE.txt`.

## Trust surface (2026-10-03)

- **Same-origin relay.** The page opens one WebSocket to `wss://web.voltminer.net/stratum`, proxied by
  Caddy to the relay on `127.0.0.1:8787` — one host, so `connect-src 'self'` is enough. The old
  `bridge.voltminer.net` endpoint still works but is no longer used by the page.
- **Strict CSP.** `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; manifest-src 'self'`, plus
  `Permissions-Policy`, HSTS, `X-Frame-Options: DENY`, COOP/COEP/CORP. The wasm glue is loaded with
  `importScripts` (not `eval`) so no `'unsafe-eval'` is needed. Headers are versioned in
  `tools/server/Caddyfile`.
- **The offline cache is the page's own files.** The service worker caches this origin's HTML, JS,
  CSS and icons and nothing else — there is no third-party entry it *could* store, because the CSP
  forbids third-party requests. It is inspectable in DevTools → Application, and clearable from the
  page with "Delete cached dataset" + "Forget my wallet" + clearing site data.
- **Consent affordances.** Start-only hashing, "Delete cached dataset" and "Forget my wallet" buttons,
  a live "Pool login / Worker id / Relay / Stored here" strip, links to the pool dashboard and API for
  the address, charging-only default, and a 60-minute session cap default. Default is 2 threads, not all.
- **Published, verifiable.** `transparency/` holds the wasm patch, the build script, the relay source and
  `SHA256SUMS` for every served asset, with the audit recipe. `.well-known/security.txt` for reports.
