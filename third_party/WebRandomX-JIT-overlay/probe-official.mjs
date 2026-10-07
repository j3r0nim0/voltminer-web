/* tevador's official RandomX v1 test vector, driven through the classic C API
   (no shim cache logic in the way): key "RandomX example key", input
   "RandomX example input" -> 8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const require = createRequire(import.meta.url);
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const EXPECT = '8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9';
const key = 'RandomX example key\0', input = 'RandomX example input\0';
const kp = m._malloc(key.length), ip = m._malloc(input.length), hp = m._malloc(32);
for (let i = 0; i < key.length; i++) m.HEAPU8[kp + i] = key.charCodeAt(i);
for (let i = 0; i < input.length; i++) m.HEAPU8[ip + i] = input.charCodeAt(i);
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const flags = m._randomx_get_flags ? m._randomx_get_flags() : 0;
console.log((process.env.RX_TAG || JS).padEnd(14), 'flags', flags);
for (const jit of [0, 1]) {
  if (m._rxSetJitEnabled) m._rxSetJitEnabled(jit);
  const cache = m._randomx_alloc_cache(0);
  const t = Date.now();
  m._randomx_init_cache(cache, kp, key.length);
  const vm = m._randomx_create_vm(0, cache, 0);
  m._randomx_calculate_hash(vm, ip, input.length, hp);
  const got = hex(hp, 32);
  console.log(`  jit=${jit}  ${got}  ${got === EXPECT ? 'MATCH' : 'MISMATCH'}  (${Date.now() - t} ms)`);
  m._randomx_destroy_vm(vm); m._randomx_release_cache(cache);
}
