# ⚡ VoltMiner Web

An open-source, standalone RandomX in-browser web miner. RandomX runs client-side in a Web Worker (WebAssembly) and submits shares directly to the visitor's own MoneroOcean wallet.

**VoltMiner Web takes 0% fee** — no cut of your hashrate, no redirected shares, no swapped payout address. The mining pool applies its standard pool fee.

```
browser Wasm worker  --WS/WSS-->  stratum bridge  --TLS-->  MoneroOcean stratum
```

## Highlights & Features

- **Consented Hashing**: Starts only when the user presses **Start** with a valid Monero wallet and consents. Closing the tab or pressing Stop terminates all Worker execution.
- **Multithreaded RandomX with Wasm JIT**: Employs a WebAssembly JIT compiler on top of the RandomX engine (`rx/0`), supporting shared ~2 GB dataset allocation across multiple C++ Web Worker pthreads.
- **Static GitHub Pages Ready**: Built-in Service Worker COOP/COEP header injection (`sw.js` + `js/pwa.js`) automatically enables `crossOriginIsolated` and `SharedArrayBuffer` on static hosts (like GitHub Pages) without needing Cloudflare or custom server headers.
- **Configurable Stratum Bridge**: Connects to any local (`ws://127.0.0.1:8787`) or custom self-hosted stratum bridge over WebSocket, configurable directly in the UI or via `?relay=` query parameter.
- **Offline & PWA Enabled**: Ships with a network-first Service Worker (`sw.js`) and web app manifest for installation on desktop and mobile.
- **On-Device Diagnostics**: Includes `diag.html` to measure hardware concurrency, WebAssembly feature support, and benchmark hashing performance.

## Quick Start: Running Locally

### 1. Start the Stratum Bridge

The browser cannot open raw TCP/TLS stratum sockets directly due to browser security sandboxes. Run the lightweight bridge locally:

Using Docker:
```bash
docker compose up -d
```

Or using Node.js:
```bash
cd tools/web-stratum-bridge
npm install
node server.mjs
```
The bridge listens on `ws://127.0.0.1:8787` and connects upstream to `gulf.moneroocean.stream:20032` (TLS).

### 2. Start the Local Web Server

```bash
node tools/dev-server.mjs
```
Open [http://127.0.0.1:8099](http://127.0.0.1:8099) in your browser.

## Deploying to GitHub Pages

1. Fork or push this repository to GitHub.
2. In your repository settings, navigate to **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch** and select your branch (e.g., `main` or `jit`) with folder `/ (root)`.
4. Your site will be live at `https://<username>.github.io/<repo>/`.
5. On first visit, the Service Worker activates and reloads once to establish `crossOriginIsolated` headers, unlocking multithreaded fast mode!

## Repository Layout

| Path | Description |
|---|---|
| `index.html`, `notices.html`, `css/`, `icons/` | Web application frontend |
| `diag.html`, `js/diag.js` | On-device diagnostics and benchmark suite |
| `sw.js`, `manifest.webmanifest`, `js/pwa.js` | PWA manifest, cache policy, and COOP/COEP isolation |
| `js/mine.js` | UI logic, storage persistence, and session controls |
| `js/miner-client.js` | Stratum JSON-RPC client, WebSocket lifecycle, bridge selection |
| `js/miner-worker.js` | Web Worker coordinator and share verification |
| `js/vendor/randomx/*.{js,wasm}` | Compiled RandomX binaries (multithreaded JIT and single-thread) |
| `tools/web-stratum-bridge/` | WebSocket-to-Stratum bridge daemon (Node.js & Docker) |
| `docker-compose.yml` | 1-command startup for self-hosting the bridge |
| `transparency/` | Reproducibility manifests, C++ patch overlays, and `SHA256SUMS` |

## Transparency & Verification

The project is designed to be fully verifiable:
- **0% Fee Guarantee**: Check your address directly on `moneroocean.stream`.
- **Integrity Hashes**: Run `tools/gen-sha256sums.sh` or check `shasum -a 256 -c transparency/SHA256SUMS`.
- **Wasm Build Recipes**: Docker build scripts and patch overlays are in `transparency/wasm-patch/`.

## License

- Site frontend and bridge code: **MIT License** (see [LICENSE](LICENSE)).
- Bundled RandomX / WebRandomX components: **BSD-3-Clause** (tevador, The Monero Project).
- Emscripten runtime: **MIT / UIUC**.
- See [notices.html](notices.html) and `js/vendor/randomx/NOTICE.txt` for full third-party notices.
