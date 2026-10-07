/* End-to-end check that the dataset built with the pre-decoded superscalar
   path is canonical: light-mode hash (computes items on the fly) must equal
   full-mode hash (reads the prebuilt dataset), and both must equal the
   RandomX v1 reference vector for seed=0. */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JS = '/tmp/rxtest/full.cjs', WASM = '/tmp/rxtest/full.wasm';
/* The real RandomX hash of the vector (seed=0, 76-byte blob, nonce at 39).
   With the uninitialised-cache bug this used to be 30aed56e... -- a value
   that only proved light mode agreed with full mode both built from a
   zeroed cache. Now it is the canonical hash and the comparison is a real
   check of the whole dataset path. */
const EXPECTED = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';

const mod = await require(JS)({
  wasmBinary: fs.readFileSync(WASM),
  locateFile: (p) => (p.endsWith('.wasm') ? WASM : p),
  mainScriptUrlOrBlob: JS,
});
mod._randomx_set_threads(4);
mod._rxSetJitEnabled(1);
if (mod._rxjit_set_feature) mod._rxjit_set_feature(3);
if (mod._rxjit_set_profile) mod._rxjit_set_profile(0);
if (mod._rxjit_set_regs_in_memory) mod._rxjit_set_regs_in_memory(1);
if (mod._rxjit_set_split_inner_dispatch) mod._rxjit_set_split_inner_dispatch(1);
if (mod._rxjit_set_use_threaded_interp) mod._rxjit_set_use_threaded_interp(1);

const seedPtr = mod._malloc(32); mod.HEAPU8.fill(0, seedPtr, seedPtr + 32);
const blobPtr = mod._malloc(76); mod.HEAPU8.fill(0, blobPtr, blobPtr + 76);
mod.HEAPU8[blobPtr + 39] = 1;
const hashPtr = mod._malloc(32);
const hex = () => Array.from(mod.HEAPU8.subarray(hashPtr, hashPtr + 32), (b) => b.toString(16).padStart(2, '0')).join('');
const hash = (tag) => { if (!mod._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr)) throw new Error(tag + ' failed'); return hex(); };

const light = hash('light');
console.log('expected  :', EXPECTED);
console.log('light     :', light, light === EXPECTED ? 'MATCH' : 'MISMATCH');

console.log('building dataset (4 threads)…');
const t = Date.now();
if (!mod._randomx_dataset_begin(0n, 0n, seedPtr)) throw new Error('dataset_begin');
for (;;) { const p = mod._randomx_dataset_step(262144); if (p < 0) throw new Error('step'); if (p >= 100) break; }
console.log(`dataset   : ${((Date.now() - t) / 1000).toFixed(1)}s, full_mem=${mod._randomx_is_full_mem()}`);

const full = hash('full');
console.log('full      :', full, full === EXPECTED ? 'MATCH' : 'MISMATCH');
console.log(light === full && full === EXPECTED ? 'PASS: decoded dataset is canonical' : 'FAIL');
