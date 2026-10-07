/* Staged-MT check: the NODE glue + the STAGED wasm bytes, so the artifact under
   test is js/vendor/randomx/web-randomx-mt.wasm itself. */
globalThis.self = globalThis;
globalThis.location = { href: 'file:///diag.html', origin: 'file://' };
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JS = process.env.RX_JS, WASM = process.env.RX_WASM, tag = process.env.RX_TAG;
const CANON = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS,
  printErr: (...a) => console.log('   wasm-err:', ...a) });
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const seedPtr = m._malloc(32); m.HEAPU8.fill(0, seedPtr, seedPtr + 32);
const blobPtr = m._malloc(76); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
const hashPtr = m._malloc(32);
const ok = m._randomx_hash(1n, 1n, seedPtr, blobPtr, 76, hashPtr);
const kat = hex(hashPtr, 32);
console.log(`${tag}: KAT ok=${ok} ${kat === CANON ? 'MATCH' : 'MISMATCH ' + kat}`);
// real-seed light mine with the JIT, to exercise the staged module's own code paths
const rp = m._malloc(32); for (let i = 0; i < 32; i++) m.HEAPU8[rp + i] = (i * 7 + 1) & 0xff;
const tp = m._malloc(8); m.HEAPU8.fill(0, tp, tp + 8);
const fp = m._malloc(4), np = m._malloc(4);
m._rxSetJitEnabled(1);
if (m._rxjit_set_use_threaded_interp) m._rxjit_set_use_threaded_interp(1);
if (m._rxjit_set_regs_in_memory) m._rxjit_set_regs_in_memory(1);
if (m._rxjit_set_split_inner_dispatch) m._rxjit_set_split_inner_dispatch(1);
const n = Number(process.env.RX_THREADS || 1);
m._randomx_set_threads(n);
const batch = 64, t = Date.now();
const done = m._randomx_mine(1n, 1n, rp, blobPtr, 76, 1, batch, tp, 8, fp, np, hashPtr);
const el = (Date.now() - t) / 1000;
console.log(`${tag}: mine threads=${m._randomx_get_threads()} ${done}/${batch} in ${el.toFixed(2)}s = ${(done/el).toFixed(1)} H/s | jit runs=${m._rxjit_stat_runs()} light=${m._rxjit_stat_light_runs()} fails=${m._rxjit_stat_fails()}`);
