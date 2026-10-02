/* Hash one blob with the same web-randomx.wasm the tab loads (single-thread). */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const WASM_JS = process.env.WASM_JS || '/tmp/WebRandomX/build/web-randomx.js';
const WASM_BIN = process.env.WASM_BIN || '/tmp/WebRandomX/build/web-randomx.wasm';

function fromHex(s) {
  const h = String(s).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function toHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

const seedHex = process.argv[2];
const blobHex = process.argv[3];
const nonceHex = process.argv[4] || '';
if (!seedHex || !blobHex) {
  console.error('usage: node hash_wasm.mjs <seed_hex> <blob_hex> [nonce_hex_le]');
  process.exit(2);
}

globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(WASM_JS).href };
globalThis.importScripts = () => {};

const src = fs.readFileSync(WASM_JS, 'utf8');
const factory = (0, eval)(src + '\ncreateWebRandomX');
if (typeof factory !== 'function') {
  console.error('createWebRandomX missing');
  process.exit(1);
}
const wasmBinary = fs.readFileSync(WASM_BIN);
const module = await factory({
  wasmBinary,
  locateFile: (p) => (p.endsWith('.wasm') ? WASM_BIN : p),
});
const seed = fromHex(seedHex);
const blob = fromHex(blobHex);
if (nonceHex) {
  const n = fromHex(nonceHex);
  if (n.length !== 4) process.exit(2);
  blob.set(n, 39);
}

const seedPtr = module._malloc(32);
const blobPtr = module._malloc(blob.length);
const hashPtr = module._malloc(32);
module.HEAPU8.set(seed, seedPtr);
module.HEAPU8.set(blob, blobPtr);
const ok = module._randomx_hash(0n, 0n, seedPtr, blobPtr, blob.length, hashPtr);
if (!ok) {
  console.error('randomx_hash returned 0');
  process.exit(1);
}
const hash = module.HEAPU8.slice(hashPtr, hashPtr + 32);
console.log(toHex(hash));
console.error(`blob_len=${blob.length} nonce=${toHex(blob.subarray(39, 43))} wasm=1`);
