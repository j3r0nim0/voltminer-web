/* Does the shim ever run randomx_init_cache for the zero seed?
   cache_for() skips init when rs_height==seedheight && rs_hash==seedhash;
   rx_s[2] starts as {hash=0,height=0}. With the all-zero reference vector
   BOTH match, so the first call may hash an UNINITIALISED cache. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const DIR = '/tmp/rxtest';
const JS = `${DIR}/rx.cjs`, WASM = `${DIR}/rx.wasm`;
const require = createRequire(import.meta.url);
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
m.HEAPU8.fill(0, seedPtr, seedPtr + 32);
m.HEAPU8.fill(0, blobPtr, blobPtr + 76);
m.HEAPU8[blobPtr + 39] = 1;
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const EXPECTED = '30aed56ecfba3f935eb906a633c3c412bb5361175bb3dda93070f08615c45c6f';
function hash(mainheight, seedheight) {
  const t = Date.now();
  m._randomx_hash(mainheight, seedheight, seedPtr, blobPtr, 76, hashPtr);
  return hex(hashPtr, 32) + `  (${Date.now() - t} ms)`;
}
console.log('expected            :', EXPECTED);
console.log('h(height=0,seed=0)  :', hash(0n, 0n));   // first call, shim may skip init
console.log('h(height=0,seed=1)  :', hash(0n, 1n));   // seedheight!=state -> forces init_cache
console.log('h(height=0,seed=0)  :', hash(0n, 0n));   // now cache is initialised for real
