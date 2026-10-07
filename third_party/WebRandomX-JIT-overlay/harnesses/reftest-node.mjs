/* Node harness: run the RandomX v1 reference vector through the built mt
   module, first with the interpreter then with the wasm JIT enabled, and
   compare both against the known-good hash. */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const DIR = '/tmp/rxtest';
const JS = process.env.RX_JS || `${DIR}/rx.cjs`;
const WASM = process.env.RX_WASM || `${DIR}/rx.wasm`;
/* RandomX v1 vector: seed = 32 zero bytes, blob = 76 zero bytes with nonce
   01000000 LE at byte 39. NOTE: the old expectation here was
   30aed56e...c45c6f, which is NOT this vector's hash -- it is what the shim
   returns when randomx_init_cache() is skipped (see rs_ready in
   src/cpp/web_randomx.cpp): the hash then ran against an uninitialised
   malloc'd cache, so its value moved with the layout (MAX_THREADS 8 -> 32
   turned it into 2f31bdb9...). This is the real hash of the vector. */
const EXPECTED = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';

const require = createRequire(import.meta.url);
const factory = require(JS);

const module = await factory({
  wasmBinary: fs.readFileSync(WASM),
  locateFile: (p) => (p.endsWith('.wasm') ? WASM : p),
  mainScriptUrlOrBlob: JS,
});

const seedPtr = module._malloc(32);
const blobPtr = module._malloc(76);
const hashPtr = module._malloc(32);
module.HEAPU8.fill(0, seedPtr, seedPtr + 32);
module.HEAPU8.fill(0, blobPtr, blobPtr + 76);
module.HEAPU8[blobPtr + 39] = 1; // nonce 01000000 LE at byte 39

const hex = (p, n) =>
  Array.from(module.HEAPU8.subarray(p, p + n), (b) => b.toString(16).padStart(2, '0')).join('');

function hash(tag) {
  const ok = module._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr);
  if (!ok) throw new Error('_randomx_hash returned 0');
  const h = hex(hashPtr, 32);
  return h;
}

console.log('expected :', EXPECTED);
const interp = hash('interp');
console.log('interp   :', interp, interp === EXPECTED ? 'MATCH' : 'MISMATCH');

let jit = null, jitErr = '';
try {
  module._rxjit_set_use_threaded_interp(1);
  if (module._rxjit_set_profile) module._rxjit_set_profile(0);
  if (module._rxjit_set_regs_in_memory) module._rxjit_set_regs_in_memory(1);
  if (module._rxjit_set_split_inner_dispatch) module._rxjit_set_split_inner_dispatch(1);
  module._rxSetJitEnabled(1);
  jit = hash('jit');
} catch (e) {
  jitErr = String((e && e.stack) || e);
}
console.log('jit      :', jit, jit === EXPECTED ? 'MATCH' : jit === null ? 'ERR ' + jitErr : 'MISMATCH');
if (module._rxjit_stat_light_runs) {
  console.log('jit stats: light_runs=' + module._rxjit_stat_light_runs()
    + ' all_runs=' + module._rxjit_stat_runs()
    + ' fails=' + module._rxjit_stat_fails());
}

process.exit(interp === EXPECTED && jit === EXPECTED ? 0 : 1);
