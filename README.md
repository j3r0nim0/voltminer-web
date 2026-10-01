# VoltMiner web miner (GitHub Pages)

Experimental, opt-in browser miner. **Not the product miner** — that is the Android XMRig binary.

```
browser RandomX Wasm  --WSS-->  wss://bridge.voltminer.net  --TLS-->  gulf.moneroocean.stream:20032
```

Hosted on **GitHub Pages**, not Cloudflare. `voltminer.net` (Cloudflare) stays marketing + App Link and redirects `/mine` here.

## Live

After Pages is enabled: `https://j3r0nim0.github.io/voltminer-web/`

The VPS bridge origin-allowlists `https://j3r0nim0.github.io` (the Origin header has no repo path).

## Local preview

```bash
cd tools/web-stratum-bridge && npm install && node server.mjs
cd web-miner && python3 -m http.server 8080
# http://localhost:8080
```

Loopback is already allowed by the bridge.

## Wasm

`js/vendor/randomx/web-randomx.{js,wasm}` are gitignored. Without them the page can log in via the bridge and will not submit shares. See that folder's `NOTICE.txt`.
