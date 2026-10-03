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
