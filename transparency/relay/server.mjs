#!/usr/bin/env node
/**
 * Origin-locked WebSocket → TLS TCP stratum bridge.
 *
 * Browser  --WSS-->  this process  --TLS-->  gulf.moneroocean.stream:20032
 *
 * Not a Cloudflare Worker. Not an open proxy:
 *   - Origin must be voltminer.net / www / http://localhost (or ALLOW_ORIGINS)
 *   - Upstream host/port are hardcoded to MoneroOcean TLS
 *   - Login is whatever the browser sent (user wallet). We do not swap it.
 *   - No dev-fee cycle.
 *
 * Local:  BRIDGE_ALLOW_INSECURE=1 node server.mjs
 * Prod:   TLS terminator (caddy/nginx) in front, wss://bridge.voltminer.net
 */
import http from 'node:http';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import { originAllowed, parseAllowlist, DEFAULT_ORIGINS } from './origin.mjs';

const POOL_HOST = 'gulf.moneroocean.stream';
const POOL_PORT = 20032; // TLS twin of 10032 — same as the Android app
// Pool presents a self-signed CN=mining.proxy cert (not a public CA).
// Pin it; do not disable verification for the rest of the internet.
const POOL_TLS_SHA256 = '239daadd5c7d0ac097376c7871f787738826eef1c024729eff870e473b970855';

function certFingerprint(cert) {
  return String(cert?.fingerprint256 || '').replace(/:/g, '').toLowerCase();
}
const LISTEN_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.BRIDGE_PORT || 8787);
const MAX_SESSIONS = Number(process.env.BRIDGE_MAX_SESSIONS || 8);
const IDLE_MS = Number(process.env.BRIDGE_IDLE_MS || 10 * 60 * 1000);

const extra = parseAllowlist(process.env.ALLOW_ORIGINS);
const allowlist = extra.size ? extra : new Set(DEFAULT_ORIGINS);

let sessions = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === ':ffff:127.0.0.1';
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      experiment: 'voltminer-web-stratum-bridge',
      pool: `${POOL_HOST}:${POOL_PORT}`,
      tls: true,
      sessions,
      maxSessions: MAX_SESSIONS,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    'VoltMiner experimental stratum bridge (not a product).\n' +
      `Upstream: tls://${POOL_HOST}:${POOL_PORT}\n` +
      'Connect with WebSocket Upgrade from an allowed Origin.\n',
  );
});

const wss = new WebSocketServer({
  server,
  clientTracking: true,
});

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  const remote = req.socket.remoteAddress || '';

  if (!originAllowed(origin, allowlist)) {
    log('reject origin', origin, 'from', remote);
    ws.close(1008, 'origin not allowed');
    return;
  }
  if (sessions >= MAX_SESSIONS) {
    log('reject capacity', sessions);
    ws.close(1013, 'bridge at capacity');
    return;
  }

  sessions += 1;
  let closed = false;
  let idleTimer = null;
  let buf = '';
  const tag = `${remote} origin=${origin} n=${sessions}`;
  log('open', tag);

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('idle', tag);
      teardown('idle');
    }, IDLE_MS);
  };
  bumpIdle();

  let tlsReady = false;
  const pending = [];

  const tcp = tls.connect({
    host: POOL_HOST,
    port: POOL_PORT,
    servername: POOL_HOST,
    // Self-signed pool cert — verify by SHA-256 pin below, not the public CA store.
    rejectUnauthorized: false,
  });

  const teardown = (why) => {
    if (closed) return;
    closed = true;
    tlsReady = false;
    pending.length = 0;
    sessions = Math.max(0, sessions - 1);
    if (idleTimer) clearTimeout(idleTimer);
    try { ws.close(); } catch { /* ignore */ }
    try { tcp.destroy(); } catch { /* ignore */ }
    log('close', tag, why || '');
  };

  const flushPending = () => {
    if (!tlsReady || !tcp.writable) return;
    while (pending.length) tcp.write(pending.shift());
  };

  tcp.setNoDelay(true);
  tcp.on('secureConnect', () => {
    const fp = certFingerprint(tcp.getPeerCertificate());
    if (fp !== POOL_TLS_SHA256) {
      log('tls fingerprint mismatch', tag, fp);
      teardown('tls-fingerprint');
      return;
    }
    tlsReady = true;
    log('tls', tag, tcp.getProtocol());
    flushPending();
  });
  tcp.on('error', (err) => {
    log('tls error', tag, err.message);
    teardown('tls-error');
  });
  tcp.on('close', () => teardown('tls-close'));
  tcp.on('data', (chunk) => {
    bumpIdle();
    if (ws.readyState === ws.OPEN) {
      try { ws.send(chunk.toString('utf8')); } catch { teardown('ws-send'); }
    }
  });

  ws.on('message', (data) => {
    bumpIdle();
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text === 'ping') {
      try { ws.send('pong'); } catch { /* ignore */ }
      return;
    }
    // Stratum is newline-delimited JSON. Tolerate one JSON object per WS frame.
    buf += text;
    if (!buf.includes('\n')) buf += '\n';
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;
      try { JSON.parse(s); } catch {
        log('drop non-json', tag);
        continue;
      }
      const frame = s + '\n';
      if (tlsReady && tcp.writable) tcp.write(frame);
      else pending.push(frame);
    }
  });
  ws.on('close', () => teardown('ws-close'));
  ws.on('error', () => teardown('ws-error'));
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const addr = server.address();
  log(`listening ws://${addr.address}:${addr.port} → tls://${POOL_HOST}:${POOL_PORT}`);
  log('origins', [...allowlist].join(', '), '+ http://localhost|127.0.0.1');
  if (!isLoopback(LISTEN_HOST) && process.env.BRIDGE_ALLOW_INSECURE !== '1') {
    log('WARNING: listening off-loopback without TLS. Put caddy/nginx in front for wss://');
  }
});
