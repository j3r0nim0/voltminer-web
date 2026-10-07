/* Verify the staged js/vendor/randomx files themselves: the worker glue with
   the browser globals it expects, then the KAT and tevador's official vector. */
globalThis.self = globalThis;
globalThis.location = { href: 'file:///diag.html', origin: 'file://' };
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JS = process.env.RX_JS, WASM = process.env.RX_WASM, tag = process.env.RX_TAG || JS;
const CANON = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
const CANONICAL_V1 = '8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9';
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const alloc = (s) => { const p = m._malloc(s); m.HEAPU8.fill(0, p, p + s); return p; };
// 1. KAT exactly as js/miner-worker.js and js/diag.js call it
const seedPtr = alloc(32), blobPtr = alloc(76), hashPtr = m._malloc(32);
m.HEAPU8[blobPtr + 39] = 1;
const ok = m._randomx_hash(1n, 1n, seedPtr, blobPtr, 76, hashPtr);
const kat = hex(hashPtr, 32);
console.log(`${tag}: KAT ok=${ok} ${kat === CANON ? 'MATCH' : 'MISMATCH ' + kat}`);
// 2. official RandomX v1 vector, interpreter and JIT
const key = 'RandomX example key\0', input = 'RandomX example input\0';
const kp = m._malloc(key.length), ip = m._malloc(input.length);
for (let i = 0; i < key.length; i++) m.HEAPU8[kp + i] = key.charCodeAt(i);
for (let i = 0; i < input.length; i++) m.HEAPU8[ip + i] = input.charCodeAt(i);
for (const jit of [0, 1]) {
  m._rxSetJitEnabled(jit);
  const c = m._randomx_alloc_cache(0);
  m._randomx_init_cache(c, kp, key.length);
  const vm = m._randomx_create_vm(0, c, 0);
  m._randomx_calculate_hash(vm, ip, input.length, hashPtr);
  const got = hex(hashPtr, 32);
  console.log(`${tag}: official vector jit=${jit} ${got === CANONICAL_V1 ? 'MATCH' : 'MISMATCH ' + got}`);
  m._randomx_destroy_vm(vm); m._randomx_release_cache(c);
}
if (m._rxjit_stat_runs) console.log(`${tag}: jit runs=${m._rxjit_stat_runs()} light=${m._rxjit_stat_light_runs()} fails=${m._rxjit_stat_fails()}`);
