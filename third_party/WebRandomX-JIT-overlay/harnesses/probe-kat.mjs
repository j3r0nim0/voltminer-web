/* The exact KAT call site now in js/miner-worker.js + js/diag.js. */
globalThis.self = globalThis;
globalThis.location = { href: 'file:///kat.html', origin: 'file://' };
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const CANON = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
m.HEAPU8.fill(0, seedPtr, seedPtr + 32); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
const hex = () => Array.from(m.HEAPU8.subarray(hashPtr, hashPtr + 32), b => b.toString(16).padStart(2, '0')).join('');
const t = Date.now();
const ok = m._randomx_hash(1n, 1n, seedPtr, blobPtr, 76, hashPtr);
const got = hex();
console.log(`${(process.env.RX_TAG || JS).padEnd(22)} ok=${ok} ${got.slice(0, 16)}… ${got === CANON ? 'MATCH' : 'MISMATCH'} (${Date.now() - t}ms)`);
