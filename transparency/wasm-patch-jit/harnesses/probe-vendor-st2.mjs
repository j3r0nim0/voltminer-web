/* The shipped ST glue is web/worker-only; fake the few globals it touches. */
globalThis.self = globalThis;
globalThis.location = { href: 'file:///Users/jerry/Developer/voltminer-web/diag.html', origin: 'file://' };
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JS = '/Users/jerry/Developer/voltminer-web/js/vendor/randomx/web-randomx.js';
const WASM = '/Users/jerry/Developer/voltminer-web/js/vendor/randomx/web-randomx.wasm';
try {
  const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
  const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
  m.HEAPU8.fill(0, seedPtr, seedPtr + 32); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
  const hex = () => Array.from(m.HEAPU8.subarray(hashPtr, hashPtr + 32), b => b.toString(16).padStart(2, '0')).join('');
  const h = (mh, sh) => { const t = Date.now(); m._randomx_hash(BigInt(mh), BigInt(sh), seedPtr, blobPtr, 76, hashPtr); return `${hex().slice(0, 16)}… (${Date.now() - t}ms)`; };
  console.log('shipped ST h(0,0):', h(0, 0));
  console.log('shipped ST h(0,1):', h(0, 1));
} catch (e) { console.log('ST build did not load in node:', String(e).slice(0, 300)); }
