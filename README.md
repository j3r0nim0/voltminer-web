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
- No service worker, no PWA, no install prompt. `index.html` unregisters any service
  worker left over from an earlier version so it cannot serve a stale `mine.js`.

## Layout

| Path | What |
|---|---|
| `index.html`, `notices.html`, `css/`, `icons/` | The site |
| `js/mine.js` | UI; `js/miner-client.js` stratum + lifecycle; `js/miner-worker.js` hashing |
| `js/vendor/randomx/*.{js,wasm}` | Committed builds (pthread + single-thread) |
| `third_party/WebRandomX-overlay/` | The C++ we compile; `build-web-randomx-mt.sh` rebuilds the wasm |
| `tools/web-stratum-bridge/` | The relay hop (see its own README) |
| `tools/rx-replay/` | Offline native-vs-Wasm hash reproduction (does not mine) |
| `tools/dev-server.mjs` | Static server with COOP/COEP for local work |

## Local preview

```bash
node tools/dev-server.mjs          # http://127.0.0.1:8099 (COOP/COEP on)
```

Without COOP/COEP the page falls back to the single-thread wasm and cache-only hashing.
The relay allows loopback origins, so a local page can still reach the real pool.

## Licences

Site code is proprietary (© 2026 VoltMiner, all rights reserved). The bundled
WebAssembly is BSD-3-Clause (RandomX/WebRandomX: tevador, The Monero Project; SoftFloat:
the Regents of the University of California) and the Emscripten runtime is MIT/UIUC.
Full texts: `notices.html` and `js/vendor/randomx/NOTICE.txt`.

## Trust surface (2026-10-03)

- **Same-origin relay.** The page opens one WebSocket to `wss://web.voltminer.net/stratum`, proxied by
  Caddy to the relay on `127.0.0.1:8787` — one host, so `connect-src 'self'` is enough. The old
  `bridge.voltminer.net` endpoint still works but is no longer used by the page.
- **Strict CSP.** `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`, plus
  `Permissions-Policy`, HSTS, `X-Frame-Options: DENY`, COOP/COEP/CORP. The wasm glue is loaded with
  `importScripts` (not `eval`) so no `'unsafe-eval'` is needed. Headers are versioned in
  `tools/server/Caddyfile`.
- **Consent affordances.** Start-only hashing, "Delete cached dataset" and "Forget my wallet" buttons,
  a live "Pool login / Worker id / Relay / Stored here" strip, links to the pool dashboard and API for
  the address, charging-only default, and a 60-minute session cap default. Default is 2 threads, not all.
- **Published, verifiable.** `transparency/` holds the wasm patch, the build script, the relay source and
  `SHA256SUMS` for every served asset, with the audit recipe. `.well-known/security.txt` for reports.
