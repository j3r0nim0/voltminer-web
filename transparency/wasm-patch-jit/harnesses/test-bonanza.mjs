import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JS = '/tmp/rxtest2/rx.cjs', WASM = '/tmp/rxtest2/rx.wasm';
/* Canonical hash of the vector. seedheight=1 is passed on the calls below so
   the shipped shim actually runs randomx_init_cache(): at (height=0,seed=0)
   it skips it (its rs_hash/rs_height are zero-initialised and match), and the
   hash then comes from an uninitialised cache -- 30aed56e...c45c6f. */
const EXPECTED = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
const mod = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const seedPtr = mod._malloc(32); mod.HEAPU8.fill(0, seedPtr, seedPtr+32);
const blobPtr = mod._malloc(76); mod.HEAPU8.fill(0, blobPtr, blobPtr+76); mod.HEAPU8[blobPtr+39]=1;
const hashPtr = mod._malloc(32);
const hex = () => [...mod.HEAPU8.subarray(hashPtr,hashPtr+32)].map(b=>b.toString(16).padStart(2,'0')).join('');
const h = () => { if(!mod._randomx_hash(0n,1n,seedPtr,blobPtr,76,hashPtr)) throw new Error('hash failed'); return hex(); };
const light = h();
console.log('light  :', light, light===EXPECTED?'MATCH':'MISMATCH');
mod._rxSetJitEnabled(1);
if (mod._rxjit_set_use_threaded_interp) mod._rxjit_set_use_threaded_interp(1);
if (mod._rxjit_set_regs_in_memory) mod._rxjit_set_regs_in_memory(1);
if (mod._rxjit_set_split_inner_dispatch) mod._rxjit_set_split_inner_dispatch(1);
console.log('jit    :', h(), '(expect MATCH)');
// >8 threads, light mode (no dataset needed): proves 32-wide path works
mod._randomx_set_threads(16);
const tp=mod._malloc(8); mod.HEAPU8.fill(0,tp,tp+8);
const fp=mod._malloc(4), np=mod._malloc(4), hp=mod._malloc(32);
const t=Date.now(); const n=mod._randomx_mine(0n,1n,seedPtr,blobPtr,76,1,512,tp,8,fp,np,hp); const el=(Date.now()-t)/1000;
console.log(`mine x16 : got ${mod._randomx_get_threads()} threads, ${n} hashes in ${el.toFixed(2)}s = ${(n/el).toFixed(1)} H/s`);
