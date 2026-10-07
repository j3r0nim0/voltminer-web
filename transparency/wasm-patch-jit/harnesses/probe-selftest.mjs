/* Does the load-time self-test cost the shipped worker a 256 MiB cache that
   real mining never reuses? Measure the heap, and which rx_s slot real
   mining settles in (via the timing/value of a follow-up (0,0) call). */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const require = createRequire(import.meta.url);
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const DEGEN = '30aed56ecfba3f935eb906a633c3c412bb5361175bb3dda93070f08615c45c6f';
const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
m.HEAPU8.fill(0, seedPtr, seedPtr + 32); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
function freeMem() {                       // greedy: how much can we still allocate
  const blk = 32 * 1024 * 1024, keep = [];
  for (let i = 0; i < 200; i++) { const p = m._malloc(blk); if (!p) break; keep.push(p); }
  const total = keep.length * blk;
  for (const p of keep) m._free(p);
  return total;
}
const t0 = (t, label) => console.log(`  ${label.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(2)}s`);
console.log('HEAPU8', (m.HEAPU8.length / 1048576).toFixed(0), 'MB; free after load:', (freeMem() / 1048576).toFixed(0), 'MB');
let t = Date.now(); m._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr); t0(t, 'self-test (0,0) -> ' + hex(hashPtr, 32).slice(0, 8));
console.log('  free after self-test:', (freeMem() / 1048576).toFixed(0), 'MB');
const H = 3500000n;
t = Date.now(); m._randomx_hash(H, H, seedPtr, blobPtr, 76, hashPtr); t0(t, 'real call (H,H) first');
console.log('  free after real call: ', (freeMem() / 1048576).toFixed(0), 'MB');
t = Date.now(); m._randomx_hash(H, H, seedPtr, blobPtr, 76, hashPtr); t0(t, 'real call (H,H) again');
t = Date.now(); m._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr);
const h = hex(hashPtr, 32);
console.log(`  follow-up (0,0): ${h.slice(0, 8)} in ${((Date.now() - t) / 1000).toFixed(2)}s -> ${h === DEGEN ? 'slot 0 untouched by real mining (still the frozen self-test cache)' : 'slot 0 was re-used/re-initialised by real mining'}`);
