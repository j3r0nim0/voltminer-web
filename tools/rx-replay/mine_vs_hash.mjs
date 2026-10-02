/* Compare _randomx_hash vs _randomx_mine on a live job blob. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const WASM_JS = '/tmp/WebRandomX/build/web-randomx.js';
const WASM_BIN = '/tmp/WebRandomX/build/web-randomx.wasm';
const job = JSON.parse(fs.readFileSync('/tmp/rx-local-test/job.json', 'utf8'));

function fromHex(s) {
  const h = String(s).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function toHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(WASM_JS).href };
globalThis.importScripts = () => {};
const factory = (0, eval)(fs.readFileSync(WASM_JS, 'utf8') + '\ncreateWebRandomX');
const module = await factory({
  wasmBinary: fs.readFileSync(WASM_BIN),
  locateFile: (p) => (p.endsWith('.wasm') ? WASM_BIN : p),
});

const seed = fromHex(job.seed_hash);
const blob = fromHex(job.blob);
const startNonce = 0x00000001;
blob[39] = startNonce & 0xff;
blob[40] = (startNonce >> 8) & 0xff;
blob[41] = (startNonce >> 16) & 0xff;
blob[42] = (startNonce >> 24) & 0xff;

const seedPtr = module._malloc(32);
const blobPtr = module._malloc(256);
const hashPtr = module._malloc(32);
const targetPtr = module._malloc(8);
const foundPtr = module._malloc(4);
const noncePtr = module._malloc(4);
module.HEAPU8.set(seed, seedPtr);
module.HEAPU8.set(blob, blobPtr);

const ok = module._randomx_hash(0n, 0n, seedPtr, blobPtr, blob.length, hashPtr);
const hashA = toHex(module.HEAPU8.slice(hashPtr, hashPtr + 32));
console.log('hash ok', ok, 'nonce', toHex(blob.subarray(39, 43)), hashA);

const target = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
module.HEAPU8.set(target, targetPtr);
module.HEAPU8.set([0, 0, 0, 0], foundPtr);
module.HEAPU8.set([0, 0, 0, 0], noncePtr);
module.HEAPU8.set(blob, blobPtr);

const n = module._randomx_mine(
  0n, 0n, seedPtr, blobPtr, blob.length,
  startNonce, 1,
  targetPtr, 4,
  foundPtr, noncePtr, hashPtr,
);
const found = module.HEAPU8[foundPtr];
const nonceOut = toHex(module.HEAPU8.slice(noncePtr, noncePtr + 4));
const hashB = toHex(module.HEAPU8.slice(hashPtr, hashPtr + 32));
console.log('mine n', n, 'found', found, 'nonce', nonceOut, hashB);
console.log(hashA === hashB && nonceOut === toHex(blob.subarray(39, 43)) ? 'MATCH YES' : 'MATCH NO');
