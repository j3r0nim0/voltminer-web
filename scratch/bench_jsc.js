var self = this;
self.location = { href: 'file:///kat.html' };
self.console = { log: print, warn: print, error: print };

var JS_PATH = arguments[0] || 'js/vendor/randomx/web-randomx.js';
var WASM_PATH = arguments[1] || 'js/vendor/randomx/web-randomx.wasm';
var profile = Number(arguments[2] || 0);
var fuse_n = Number(arguments[3] || -1);
var light_mlp = Number(arguments[4] || -1);
var shared_code = Number(arguments[5] || -1);
var aes_simd = Number(arguments[6] || -1);
var kernel_k = Number(arguments[7] || -1);

load(JS_PATH);
var wasmBytes = read(WASM_PATH, 'binary');

createWebRandomX({
  wasmBinary: wasmBytes,
  locateFile: function(p) { return p; }
}).then(function(m) {
  var seedPtr = m._malloc(32);
  for (var i = 0; i < 32; i++) m.HEAPU8[seedPtr + i] = (i * 7 + 1) & 0xff;
  var blobPtr = m._malloc(76);
  m.HEAPU8.fill(0, blobPtr, blobPtr + 76);
  m.HEAPU8[blobPtr + 39] = 1;
  var tp = m._malloc(8);
  m.HEAPU8.fill(0, tp, tp + 8);
  var fp = m._malloc(4), np = m._malloc(4), hp = m._malloc(32);

  if (m._rxSetJitEnabled) m._rxSetJitEnabled(1);
  if (m._rxjit_set_use_threaded_interp) m._rxjit_set_use_threaded_interp(1);

  m._rxjit_set_profile(profile);
  if (fuse_n >= 0 && m._rxjit_set_fuse_n) m._rxjit_set_fuse_n(fuse_n);
  if (light_mlp >= 0 && m._rxjit_set_light_mlp) m._rxjit_set_light_mlp(light_mlp);
  if (shared_code >= 0 && m._rxjit_set_shared_code) m._rxjit_set_shared_code(shared_code);
  if (aes_simd >= 0 && m._rxjit_set_aes_simd) m._rxjit_set_aes_simd(aes_simd);
  if (kernel_k >= 0 && m._rxjit_set_kernel_k) m._rxjit_set_kernel_k(kernel_k);

  print("Config: profile=" + profile + " fuse=" + fuse_n + " mlp=" + light_mlp + " shared=" + shared_code + " aes=" + aes_simd + " k=" + kernel_k);

  // Warmup 5 hashes
  m._randomx_mine(1n, 1n, seedPtr, blobPtr, 76, 1, 5, tp, 8, fp, np, hp);

  // Bench 20 hashes
  var batch = 20;
  var t0 = Date.now();
  var done = m._randomx_mine(1n, 1n, seedPtr, blobPtr, 76, 1, batch, tp, 8, fp, np, hp);
  var el = (Date.now() - t0) / 1000;
  var hs = (done / el).toFixed(1);
  print("Result: " + done + " hashes in " + el.toFixed(3) + "s -> " + hs + " H/s (single-core)");

  // Check KAT
  var katSeedPtr = m._malloc(32), katBlobPtr = m._malloc(76), katHashPtr = m._malloc(32);
  m.HEAPU8.fill(0, katSeedPtr, katSeedPtr + 32);
  m.HEAPU8.fill(0, katBlobPtr, katBlobPtr + 76);
  m.HEAPU8[katBlobPtr + 39] = 1;
  var ok = m._randomx_hash(1n, 1n, katSeedPtr, katBlobPtr, 76, katHashPtr);
  var got = "";
  for (var j = 0; j < 32; j++) {
    var b = m.HEAPU8[katHashPtr + j].toString(16);
    got += (b.length < 2 ? "0" + b : b);
  }
  var CANON = "086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3";
  print("KAT: " + (got === CANON ? "MATCH" : "MISMATCH! got=" + got));
}).catch(function(e) {
  print("Error: " + e);
});
drainMicrotasks();
