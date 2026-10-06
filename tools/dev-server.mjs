#!/usr/bin/env node
/**
 * Local preview server for the Browser Experiment.
 *
 * Sends Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy so the page
 * becomes crossOriginIsolated and the pthread wasm build (one shared ~2 GB
 * dataset, 1-4 C++ threads) can run. A plain static server cannot do this, and
 * without it the miner silently falls back to the single-thread build.
 *
 *   node tools/dev-server.mjs            # http://127.0.0.1:8099
 *   PORT=8080 ROOT=. node tools/dev-server.mjs
 *
 * Dev only. Not the production server (that is Caddy in front of the relay).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.ROOT || path.join(HERE, '..'));
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Directory requests get their index.html, the way Caddy's file_server does
    // in production — without this, /transparency/ (linked from the footer)
    // 404s locally only.
    const file = path.join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`serving ${ROOT} on http://${HOST}:${PORT} (COOP/COEP on)`);
  });
