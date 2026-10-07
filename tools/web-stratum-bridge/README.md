# Experimental web stratum bridge (VPS, not Cloudflare)

Origin-locked **WebSocket → TLS TCP** hop so `/mine.html` can speak RandomX
stratum to MoneroOcean. Hashing stays in the browser. This process only copies
newline-delimited JSON.

```
browser RandomX Wasm  --WSS-->  this bridge  --TLS-->  gulf.moneroocean.stream:20032
```

**Not a product.** Same audience caveats as `/mine`: toy H/s vs the Android
XMRig binary, ad-blockers, iOS will suspend the tab. You sit on wallet/login
for the life of the socket — that’s why this is opt-in experiment infra, not
the APK path (the app talks TLS to the pool itself).

Ignore `node_modules/` — not committed.

## Hard rules

- **Not a Cloudflare Worker.** `cloudflare:sockets` + public `WebSocketPair` is
  the VPN/similar-proxy pattern in Cloudflare’s self-serve terms. Paid tier
  does not change that. Run this on a VPS (or `localhost` for fun).
- **Origin lock.** Default allowlist is `https://voltminer.net`,
  `https://www.voltminer.net`, plus `http://localhost` / `127.0.0.1` for
  preview. Anything else is `1008`.
- **Upstream is hardcoded** to `gulf.moneroocean.stream:20032` (TLS). Clients
  cannot pick a host.
- **No fee cycle, no login swap.** The browser’s `mining.authorize` user is
  forwarded as-is.
- **Cap** `BRIDGE_MAX_SESSIONS` (default 8) so this cannot become a public
  stratum farm.

## Run locally

```bash
cd tools/web-stratum-bridge
npm install
node server.mjs          # ws://127.0.0.1:8787
```

Then in another terminal:

```bash
cd website
python3 -m http.server 8080
```

Open `http://localhost:8080/mine.html`. The page uses `ws://127.0.0.1:8787`
when the hostname is loopback.

Health: `curl http://127.0.0.1:8787/health`

Tests (no pool): `npm test`

## Production (your VPS)

1. Listen on loopback: `BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=8787 node server.mjs`
2. Terminate TLS with caddy/nginx → `wss://bridge.voltminer.net`
3. Restrict nginx to `Upgrade: websocket` + the same origins if you want a
   second gate.
4. Set `website/js/miner-client.js` `PROD_BRIDGE_WS` to that `wss://` URL
   (or `localStorage.voltminer.web.bridgeWs` on the experiment page).

Do **not** bind `0.0.0.0:8787` to the public internet without TLS.

**Serving the page from voltminer.net?** That site's CSP is `connect-src 'self'`
(`tools/server/Caddyfile:50`), so a page served from there cannot reach this hop — deliberate,
it is what keeps the site's "one host, no exfiltration endpoint" claim honest. To mine through
your own hop, serve the page from your own origin too. Options and tradeoffs:
`docs/BACKLOG.md` -> "Hosting your own TCP hop".

## What this does not do

- Compile RandomX Wasm. See `website/js/vendor/randomx/NOTICE.txt`.
- Make browser H/s comparable to the APK.
- Replace MoneroOcean. P2Pool still needs a node whose wallet is yours.
