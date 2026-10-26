globalThis.self = globalThis;
globalThis.location = { href: 'file:///bench.html', origin: 'file://' };
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const JS = process.env.RX_JS || `${process.cwd()}/js/vendor/randomx/web-randomx.js`;
const WASM = process.env.RX_WASM || `${process.cwd()}/js/vendor/randomx/web-randomx.wasm`;
const m = await require(JS)({
  wasmBinary: fs.readFileSync(WASM),
  locateFile: p => p.endsWith('.wasm') ? WASM : p,
  mainScriptUrlOrBlob: JS
});

const seedPtr = m._malloc(32);
for (let i = 0; i < 32; i++) m.HEAPU8[seedPtr + i] = (i * 7 + 1) & 0xff;
const blobPtr = m._malloc(76);
m.HEAPU8.fill(0, blobPtr, blobPtr + 76);
m.HEAPU8[blobPtr + 39] = 1;
const tp = m._malloc(8);
m.HEAPU8.fill(0, tp, tp + 8);
const fp = m._malloc(4), np = m._malloc(4), hp = m._malloc(32);

if (m._rxSetJitEnabled) m._rxSetJitEnabled(1);
if (m._rxjit_set_use_threaded_interp) m._rxjit_set_use_threaded_interp(1);

// Configure knobs if present
const profile = Number(process.env.RX_PROFILE ?? 1);
const fuse_n = Number(process.env.RX_FUSE ?? -1);
const light_mlp = Number(process.env.RX_LIGHT_MLP ?? -1);
const aes_simd = Number(process.env.RX_AES_SIMD ?? -1);

if (m._rxjit_set_profile) m._rxjit_set_profile(profile);
if (fuse_n >= 0 && m._rxjit_set_fuse_n) m._rxjit_set_fuse_n(fuse_n);
if (light_mlp >= 0 && m._rxjit_set_light_mlp) m._rxjit_set_light_mlp(light_mlp);
if (aes_simd >= 0 && m._rxjit_set_aes_simd) m._rxjit_set_aes_simd(aes_simd);

console.log(`Profile=${profile} fuse_n=${fuse_n} light_mlp=${light_mlp} aes_simd=${aes_simd}`);

// Warmup 5 hashes
m._randomx_mine(1n, 1n, seedPtr, blobPtr, 76, 1, 5, tp, 8, fp, np, hp);

// Bench 30 hashes
const batch = 30;
const t0 = Date.now();
const done = m._randomx_mine(1n, 1n, seedPtr, blobPtr, 76, 1, batch, tp, 8, fp, np, hp);
const el = (Date.now() - t0) / 1000;
console.log(`Computed ${done} hashes in ${el.toFixed(3)}s -> ${(done / el).toFixed(1)} H/s`);
