# VoltMiner Web Stratum Bridge

Lightweight **WebSocket → TLS TCP** stratum bridge that connects web browsers to MoneroOcean. Hashing stays in the browser; this process only proxies newline-delimited stratum JSON.

```
browser RandomX Wasm  --WS/WSS-->  this bridge  --TLS-->  gulf.moneroocean.stream:20032
```

## Security & Architecture

- **Origin lock.** Default allowlist includes `https://j3r0nim0.github.io` and local loopback. Setting `ALLOW_ORIGINS=*` allows requests from any web host.
- **Hardcoded upstream.** Proxies to `gulf.moneroocean.stream:20032` (TLS) with certificate pinned by SHA-256 fingerprint.
- **No fee cycle, no login swap.** The browser’s `mining.authorize` login is forwarded as-is.
- **Session cap.** Configurable `BRIDGE_MAX_SESSIONS` (default 8) to protect host bandwidth.

## Quick Start (Docker)

From the repository root:

```bash
docker compose up -d
```

The bridge is now listening on `ws://127.0.0.1:8787` and ready to receive connections from GitHub Pages or localhost.

## Run with Node.js

```bash
cd tools/web-stratum-bridge
npm install
node server.mjs          # listens on ws://127.0.0.1:8787
```

Health check:
```bash
curl http://127.0.0.1:8787/health
```

Run unit tests:
```bash
npm test
```

## Self-Hosting in Production (with TLS)

If exposing the bridge over the public internet, put Caddy, Nginx, or Traefik in front to terminate TLS (`wss://`):

```caddy
bridge.your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then in the VoltMiner Web UI or URL parameter, set the bridge URL:
`https://j3r0nim0.github.io/voltminer-web/?relay=wss://bridge.your-domain.com`
