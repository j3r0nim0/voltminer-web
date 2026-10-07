/* RX_JS / RX_WASM select the build; RX_SEQ = "0,0;0,1" etc. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const JS = process.env.RX_JS, WASM = process.env.RX_WASM;
const seq = (process.env.RX_SEQ || '0,0;0,1').split(';').map(s => s.split(',').map(Number));
const require = createRequire(import.meta.url);
const m = await require(JS)({ wasmBinary: fs.readFileSync(WASM), locateFile: p => p.endsWith('.wasm') ? WASM : p, mainScriptUrlOrBlob: JS });
const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
m.HEAPU8.fill(0, seedPtr, seedPtr + 32);
m.HEAPU8.fill(0, blobPtr, blobPtr + 76);
m.HEAPU8[blobPtr + 39] = 1;
const hex = (p, n) => Array.from(m.HEAPU8.subarray(p, p + n), b => b.toString(16).padStart(2, '0')).join('');
const out = [];
for (const [mh, sh] of seq) {
  const t = Date.now();
  m._randomx_hash(BigInt(mh), BigInt(sh), seedPtr, blobPtr, 76, hashPtr);
  out.push(`h(${mh},${sh})=${hex(hashPtr, 32).slice(0, 16)}… ${Date.now() - t}ms`);
  if (sh === 0) { const p = m._malloc(1024); m._free(p); }   // small heap churn, like a real app
}
console.log((process.env.RX_TAG || JS).padEnd(16), '|', out.join('  '));
