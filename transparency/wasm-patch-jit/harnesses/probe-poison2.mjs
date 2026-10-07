/* Fixed build: the vector's hash must no longer depend on heap contents.
   Control vs. a 256 MiB block poisoned+freed (exactly the reuse the cache
   allocation gets) vs. 4000 poisoned small blocks kept alive. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const require = createRequire(import.meta.url);
const CANON = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
async function run(mode) {
  const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
  const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
  m.HEAPU8.fill(0, seedPtr, seedPtr + 32); m.HEAPU8.fill(0, blobPtr, blobPtr + 76); m.HEAPU8[blobPtr + 39] = 1;
  if (mode === 'poison256') { const p = m._malloc(256*1024*1024); m.HEAPU8.fill(0xAA, p, p + 256*1024*1024); m._free(p); }
  if (mode === 'poison-small') { const keep = []; for (let i = 0; i < 4000; i++) { const p = m._malloc(4096); m.HEAPU8.fill(0x5A, p, p + 4096); keep.push(p); } }
  m._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr);
  const h = Array.from(m.HEAPU8.subarray(hashPtr, hashPtr + 32), b => b.toString(16).padStart(2, '0')).join('');
  console.log(`  ${mode.padEnd(12)} ${h} ${h === CANON ? 'MATCH' : 'MISMATCH'}`);
}
for (const mode of ['control', 'poison256', 'poison-small']) await run(mode);
