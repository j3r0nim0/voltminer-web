import fs from 'node:fs';
import { createRequire } from 'node:module';
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const require = createRequire(import.meta.url);
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const seedPtr = m._malloc(32);
for (let i = 0; i < 32; i++) m.HEAPU8[seedPtr + i] = (i * 7 + 1) & 0xff;   // real (non-degenerate) seed
const blobPtr = m._malloc(76); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
const tp = m._malloc(8); m.HEAPU8.fill(0, tp, tp + 8);   // zero target: never finds
const fp = m._malloc(4), np = m._malloc(4), hp = m._malloc(32);
m._rxSetJitEnabled(1); if (m._rxjit_set_use_threaded_interp) m._rxjit_set_use_threaded_interp(1);
if (m._rxjit_set_regs_in_memory) m._rxjit_set_regs_in_memory(1);
if (m._rxjit_set_split_inner_dispatch) m._rxjit_set_split_inner_dispatch(1);
for (const n of [1, 8, 16, 32]) {
  console.log('set_threads', m._randomx_set_threads(n), '-> got', m._randomx_get_threads());
  const batch = n * 64, t = Date.now();
  const done = m._randomx_mine(1n, 1n, seedPtr, blobPtr, 76, 1, batch, tp, 8, fp, np, hp);
  const el = (Date.now() - t) / 1000;
  console.log(`  mine x${n}: ${done}/${batch} hashes in ${el.toFixed(2)}s = ${(done / el).toFixed(1)} H/s (${(done / el / n).toFixed(1)} H/s/thread)`);
}
