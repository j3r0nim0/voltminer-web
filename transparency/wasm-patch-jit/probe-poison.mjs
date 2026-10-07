/* The shim skips randomx_init_cache() when the requested seed equals its
   record (rs_hash=0s, rs_height=0 => the all-zero reference vector). If the
   zero-seed hash is a function of UNINITIALISED heap, then handing the
   allocator a poisoned 256 MiB block before the first call must change it. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const DIR = '/tmp/rxtest', JS = `${DIR}/rx.cjs`, WASM = `${DIR}/rx.wasm`;
const require = createRequire(import.meta.url);
const EXPECTED = '30aed56ecfba3f935eb906a633c3c412bb5361175bb3dda93070f08615c45c6f';

async function run(poison) {
  const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
  const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
  m.HEAPU8.fill(0, seedPtr, seedPtr + 32);
  m.HEAPU8.fill(0, blobPtr, blobPtr + 76);
  m.HEAPU8[blobPtr + 39] = 1;
  const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
  if (poison !== null) {
    const SZ = 256 * 1024 * 1024;                    // CacheSize
    const p = m._malloc(SZ);
    m.HEAPU8.fill(poison, p, p + SZ);
    m._free(p);                                      // hand it back to the allocator
  }
  const h = (mh, sh) => { m._randomx_hash(BigInt(mh), BigInt(sh), seedPtr, blobPtr, 76, hashPtr); return hex(hashPtr, 32); };
  return { zero: h(0, 0), one: h(0, 1) };
}
for (const [name, poison] of [['control (no poison)', null], ['poisoned 0xAA', 0xAA], ['poisoned 0x5A', 0x5A]]) {
  const r = await run(poison);
  console.log(`${name.padEnd(20)} zero-seed(height=0) = ${r.zero} ${r.zero === EXPECTED ? '(MATCH)' : '(CHANGED!)'}`);
  console.log(`${''.padEnd(20)} init(height=1)      = ${r.one}`);
}
