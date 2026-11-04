# Transparency

This folder is the verifiable part of the VoltMiner Web project.
It exists because the answer to "is this page doing something dishonest?"
should be a command you can run, not a sentence you have to believe.

## What this page is

A **consented** cryptominer: RandomX compiled to WebAssembly, running in a Web
Worker, sending shares to MoneroOcean with **your** wallet as the pool login.
Nothing starts until you press Start. The page itself lists what it stores and
what it refuses to do; there are buttons to delete the dataset cache and forget
your wallet.

VoltMiner takes **0%**. The login is the wallet you typed, and the relay changes
nothing in either direction, so a redirected payout would be visible as somebody
else's address on the MoneroOcean dashboard.

## Audit it in five minutes

1. **Read what runs.** Every file is served unminified and open source in this
   repository. The page is `index.html`; the logic is `js/mine.js` (UI),
   `js/miner-client.js` (stratum + lifecycle), `js/miner-worker.js` (hashing),
   `js/pwa.js` (install + update) and `sw.js` (offline cache + COOP/COEP isolation).
   `diag.html` prints what a device supports.
2. **Check that no third-party code can load.** The Content Security Policy pins
   `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; manifest-src 'self' …`.
   There is no analytics, no CDN, no remote import, no inline script.
3. **Check the bytes you were served.**
   `curl -s https://j3r0nim0.github.io/voltminer-web/js/vendor/randomx/web-randomx-mt.wasm | shasum -a 256`
   (or in a local checkout: `shasum -a 256 js/vendor/randomx/web-randomx-mt.wasm`)
   and compare with `SHA256SUMS` in this folder.
4. **Check the wasm is a build of public code.** `wasm-patch/` is the
   shared-memory `web-randomx-mt` build: every file we changed on top of
   [aa022/RandomX-bonanza](https://github.com/aa022/RandomX-bonanza) at commit
   `f9848e3` — a WebAssembly JIT backend on the RandomX engine — plus
   `build-web-randomx-mt.sh` (Docker + Emscripten 4.0.10) that reproduces it. The
   patch is small: our API shim (little-endian nonce at blob byte 39, a pthread
   mine path, the chunked dataset API) and three edits to their build script.
   The single-thread `web-randomx` binary is the earlier WebRandomX build; its
   overlay is `wasm-patch-webrandomx/`.
5. **Read the relay.** `relay/` (and `tools/web-stratum-bridge/`) is the entire
   bridge server: it accepts one WebSocket from an allowlisted Origin, opens one
   TLS connection to the pool's host and port (certificate pinned by SHA-256),
   checks each line is JSON, and forwards bytes. It never rewrites a login, a job
   or a share.
6. **Check the payout.** The page prints the exact login it sent
   (`<your wallet>+10000`) and links the pool's own dashboard and API for that
   address. That number is the ground truth, not our word.
7. **Inspect the offline copy.** `sw.js` is the whole cache policy and it is
   short: navigations go to the network first (so the page is never stale while
   you are online), sub-resources are served from cache while being refreshed,
   and `/stratum` is never touched. The cache holds this origin's own files and
   nothing else — it cannot hold anything else, because the CSP forbids
   third-party requests. See it under DevTools → Application → Cache Storage, or
   clear it with the buttons on the page plus clearing site data.

## What the app cache stores

Two caches, both named `vmw-*`, both filled only from this origin: the app shell
(the HTML, the stylesheet, the icons, and the manifest) and the assets you
actually requested. Nothing about you is in either one. Installing to the Home
Screen adds no storage the page did not already have — on iOS it is even a
*separate* container from the browser's, so the app starts with a fresh wallet
field.

## Open source & dataset cache

- The entire project (UI, client, workers, build harnesses, and bridge) is open source under the MIT and BSD licenses.
- The 2 GB dataset is not data about you; it is RandomX's cache for the current
  network seed, stored in this origin's private storage. Delete it with the
  button on the page or by clearing site data.

## What the relay logs

Connection events only: peer IP, the Origin header, session count, and
accept/close reasons. Stratum payloads — including your wallet in the login
line — are never parsed for content and never logged. Your address is not
stored anywhere on our side.

## Contact & Issues

- Issues & discussions: <https://github.com/j3r0nim0/voltminer-web/issues>
- Security advisories: <https://github.com/j3r0nim0/voltminer-web/security/advisories/new>
  (or `/.well-known/security.txt`).

Third-party licences for the bundled Wasm (the RandomX engine and Berkeley
SoftFloat are BSD-3-Clause; the wasm JIT backend is CC0; `jit_stubs/semifloat.c`
and `mulh.c` are BSD-3-Clause © tevador and l-m; the Emscripten runtime is MIT)
are in `js/vendor/randomx/NOTICE.txt` and `notices.html`.
