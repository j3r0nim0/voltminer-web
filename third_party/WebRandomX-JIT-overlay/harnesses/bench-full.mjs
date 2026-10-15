/* Full-memory hashrate bench for the ported WebRandomX mt build, driven
   through its own shim (dataset_begin/step + randomx_hash/randomx_mine),
   mirroring the miner. Uses the node build under /tmp/rxtest.
     --threads 1   -> single randomx_hash loop
     --threads N>1 -> randomx_mine batches on N C-side pthreads */
globalThis.self = globalThis;
globalThis.location = { href: 'file:///bench.html' };
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JS = process.env.RX_JS || '/tmp/rxtest/full.cjs';
const WASM = process.env.RX_WASM || '/tmp/rxtest/full.wasm';
const factory = require(JS);

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DURATION = Number(arg('--duration', '20'));
const THREADS = Number(arg('--threads', '1'));
const NOJIT = args.includes('--nojit');
const CHUNK = 262144;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const module = await factory({
  wasmBinary: fs.readFileSync(WASM),
  locateFile: (p) => (p.endsWith('.wasm') ? WASM : p),
  mainScriptUrlOrBlob: JS,
});
console.log(`[${el()}s] wasm ready`);

if (THREADS > 1 && module._randomx_set_threads) module._randomx_set_threads(THREADS);

if (!NOJIT) {
  if (module._rxSetJitEnabled) module._rxSetJitEnabled(0);
  if (module._rxjit_set_feature) module._rxjit_set_feature(3);
  if (module._rxjit_set_profile) module._rxjit_set_profile(0);
  if (module._rxjit_set_regs_in_memory) module._rxjit_set_regs_in_memory(1);
  if (module._rxjit_set_split_inner_dispatch) module._rxjit_set_split_inner_dispatch(1);
  if (module._rxjit_set_use_threaded_interp) module._rxjit_set_use_threaded_interp(1);
  if (module._rxjit_set_supjit_enabled) module._rxjit_set_supjit_enabled(1);
  module._rxSetJitEnabled(1);
}

const seedPtr = module._malloc(32);
const seed = new Uint8Array(32);
for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 1) & 0xff;
module.HEAPU8.set(seed, seedPtr);

console.log(`[${el()}s] dataset_begin`);
if (!module._randomx_dataset_begin(1n, 1n, seedPtr)) { console.error('dataset_begin failed'); process.exit(1); }
const total = module._randomx_dataset_items();
console.log(`[${el()}s] dataset items ${total}, step ${CHUNK} at a time`);
let pct = 0;
for (;;) {
  const p = module._randomx_dataset_step(CHUNK);
  if (p < 0) { console.error('dataset_step failed'); process.exit(1); }
  if (p >= 100) break;
  if (p >= pct + 10) { pct = p; console.log(`[${el()}s] dataset ${p}%`); }
}
console.log(`[${el()}s] dataset ready, full_mem=${module._randomx_is_full_mem()}`);

const BLOB_LEN = 76, NONCE_OFF = 39;
const blobPtr = module._malloc(BLOB_LEN);
const blob = new Uint8Array(BLOB_LEN);
for (let i = 0; i < BLOB_LEN; i++) blob[i] = i & 0xff;
module.HEAPU8.set(blob, blobPtr);

let hashes = 0;
let mode;
const deadline = Date.now() + DURATION * 1000;
const tStart = Date.now();

if (THREADS > 1 && typeof module._randomx_mine === 'function') {
  mode = `randomx_mine x${THREADS} pthreads`;
  const targetPtr = module._malloc(8); module.HEAPU8.fill(0, targetPtr, targetPtr + 8);
  const foundPtr = module._malloc(4);
  const nonceOutPtr = module._malloc(4);
  const hashOutPtr = module._malloc(32);
  const batch = Math.max(1024, THREADS * 512);
  let nonce = 1;
  while (Date.now() < deadline) {
    const n = module._randomx_mine(1n, 1n, seedPtr, blobPtr, BLOB_LEN,
      nonce >>> 0, batch, targetPtr, 8, foundPtr, nonceOutPtr, hashOutPtr);
    if (n <= 0) { console.error('randomx_mine returned', n); break; }
    nonce = (nonce + n) >>> 0;
    hashes += n;
  }
} else {
  mode = 'randomx_hash';
  const hashPtr = module._malloc(32);
  while (Date.now() < deadline) {
    blob[NONCE_OFF] = hashes & 0xff;
    blob[NONCE_OFF + 1] = (hashes >> 8) & 0xff;
    blob[NONCE_OFF + 2] = (hashes >> 16) & 0xff;
    blob[NONCE_OFF + 3] = (hashes >> 24) & 0xff;
    module.HEAPU8.set(blob, blobPtr);
    if (!module._randomx_hash(1n, 1n, seedPtr, blobPtr, BLOB_LEN, hashPtr)) { console.error('hash failed'); break; }
    hashes++;
  }
}
const elapsed = (Date.now() - tStart) / 1000;
const rate = hashes / elapsed;
console.log('────────────────────────────────────────────');
console.log(`  mode      ${mode}`);
console.log(`  threads   ${THREADS}`);
console.log(`  jit       ${NOJIT ? 'off' : 'on'}`);
console.log(`  hashes    ${hashes}`);
console.log(`  elapsed   ${elapsed.toFixed(2)} s`);
console.log(`  hashrate  ${rate.toFixed(1)} H/s  (${(rate / THREADS).toFixed(1)} H/s/thread)`);
if (module._rxjit_stat_runs) {
  console.log(`  jit stats  runs=${module._rxjit_stat_runs()} light_runs=${module._rxjit_stat_light_runs()} fails=${module._rxjit_stat_fails()}`);
}
console.log('────────────────────────────────────────────');
