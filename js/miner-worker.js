/* RandomX hash worker (experimental).

   The pthread build carries a WebAssembly JIT (enableRandomXJit, below); the
   single-thread build exposes no JIT and runs the portable interpreter.
   Light/cache hashes immediately. Then we allocate the ~2 GB dataset and
   either restore it from OPFS (keyed by seed_hash) or fill it in C++
   chunks. A seed change drops the old file and rebuilds. */

function isPthreadNoise(err) {
  const s = String(err && err.message ? err.message : err);
  return /unwind|ErrorEvent|Uncaught\s+\d+/i.test(s) || /^\d+$/.test(s.trim());
}

self.addEventListener('error', (e) => {
  if (isPthreadNoise(e.message || e.error || e)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  }
  return undefined;
});
self.addEventListener('unhandledrejection', (e) => {
  if (isPthreadNoise(e.reason)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
});

const USE_MT = typeof SharedArrayBuffer === 'function';
const WASM_JS = new URL(
  USE_MT ? 'vendor/randomx/web-randomx-mt.js' : 'vendor/randomx/web-randomx.js',
  self.location,
).href;
const DS_CHUNK = 262144; // ~16 MB of dataset items per compute step
const IO_CHUNK = 16 * 1024 * 1024; // 16 MB copy to/from OPFS
const OPFS_BUDGET_MS = 2500;
const OPFS_DIR = 'voltminer-rx';

let modulePromise = null;
let rx = null;
let nonceBase = (Math.random() * 0x100000000) >>> 0;
let lightReady = false;
let dsPhase = 'idle'; // idle | try | wait | restore | filling | saving | done | skip
let lastPct = -1;
let hashing = true;
let dsGen = 0;
let cachedSeedHex = '';
let cpuThreads = 1;
// The ~2.5 GB fast dataset is an explicit opt-in (see js/mine.js); light/cache
// is the soft default. Set from the client's { type:'config' } message.
let fullDataset = false;

function hexToBytes(hex) {
  const h = String(hex || '').replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/* ---- WASM JIT bring-up ----------------------------------------------------
   The RandomX-bonanza port keeps the interpreter unless JS asks for the JIT:
   the C side starts with g_jitEnabled = 0 and only rxSetJitEnabled(1) flips it.
   With it off every hash runs the portable interpreter (~18 H/s/thread on an
   M3); with the bundle below, ~68. The flags are global to the module and only
   need setting once, before the first hash.

   The bundle is aa022's own default (public/worker.js): a *resident* threaded
   interpreter instead of one WebAssembly.Module compiled per program (that
   per-program compile is what makes rxSetJitEnabled(1) alone only ~14%
   faster), plus V3 regs-in-memory, V2-minimal split dispatch, INLINE_FPRC_ZERO
   and the arm/x86 module-gen profile. supjit is the SuperscalarHash kernel used
   by dataset init. */
function detectJitFeature() {
  function probe(opcodeBytes, arity) {
    const typeEntry = [0x60, arity, ...Array(arity).fill(0x7b), 0x01, 0x7b];
    const typeSection = [0x01, typeEntry.length + 1, 0x01, ...typeEntry];
    const funcSection = [0x03, 0x02, 0x01, 0x00];
    const body = [0x00];
    for (let i = 0; i < arity; i++) body.push(0x20, i);
    body.push(...opcodeBytes); body.push(0x0b);
    const codeBody = [body.length, ...body];
    const codeSection = [0x0a, codeBody.length + 1, 0x01, ...codeBody];
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...typeSection, ...funcSection, ...codeSection]);
    try { return WebAssembly.validate(bytes); } catch { return false; }
  }
  const hasRelaxedSimd = probe([0xfd, 0x80, 0x02], 2); // i8x16.relaxed_swizzle
  const hasFma = probe([0xfd, 0x87, 0x02], 3);         // f64x2.relaxed_madd
  if (hasRelaxedSimd && hasFma) return 3;
  if (hasRelaxedSimd) return 1;
  return 0;
}

function isX86() {
  const typeSection = [0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f];
  const funcSection = [0x03, 0x02, 0x01, 0x00];
  const exportSection = [0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00];
  const data = Array.from({ length: 16 }, (_, i) => 10 + i);
  const body = [0x00, 0xfd, 0x0c, ...data, 0xfd, 0x0c, ...Array(16).fill(0x11),
    0xfd, 0x80, 0x02, 0xfd, 0x16, 0x00, 0x0b];
  const codeSection = [0x0a, body.length + 2, 0x01, body.length, ...body];
  const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSection, ...funcSection, ...exportSection, ...codeSection]);
  try { return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f() === 11; }
  catch { return false; }
}

function enableRandomXJit(module) {
  if (typeof module._rxSetJitEnabled !== 'function') return '';
  let feature = detectJitFeature();
  if (module._rxjit_set_feature) module._rxjit_set_feature(feature);
  // Tell the C side how many 64 KiB pages the generated module may declare.
  let maxPages = 65536;
  try {
    const t = module.wasmMemory && module.wasmMemory.type;
    if (typeof t === 'function') {
      const desc = t.call(module.wasmMemory);
      if (desc && desc.maximum) maxPages = desc.maximum;
    }
  } catch { /* keep default */ }
  if (module._rxjit_set_max_memory_pages) module._rxjit_set_max_memory_pages(maxPages);
  if (module._rxjit_set_use_threaded_interp) module._rxjit_set_use_threaded_interp(1);
  feature |= 4; // INLINE_FPRC_ZERO
  if (module._rxjit_set_feature) module._rxjit_set_feature(feature);
  if (module._rxjit_set_regs_in_memory) module._rxjit_set_regs_in_memory(1);
  if (module._rxjit_set_split_inner_dispatch) module._rxjit_set_split_inner_dispatch(1);
  if (module._rxjit_set_profile) {
    const ua = String((self.navigator && self.navigator.userAgent) || '');
    const jsc = /AppleWebKit\//.test(ua) && !/Chrom(e|ium)\//.test(ua);
    // Tuning profile:
    // Chromium/V8 gets Profile 1 (fuse_n=800, light_mlp=2, shared_code=1, aes_simd=1, kernel_k=4) -> 95 H/s.
    // Safari/JSC gets Profile 0 (fuse_n=200, light_mlp=0, shared_code=0, aes_simd=0, kernel_k=1)
    // because WebKit's OMG optimizing JIT aborts tier-up on br_table > 255 or MLP loop expansion.
    module._rxjit_set_profile(jsc ? 0 : 1);
    if (module._rxjit_set_fuse_n) module._rxjit_set_fuse_n(jsc ? 200 : 800);
    if (module._rxjit_set_light_mlp) module._rxjit_set_light_mlp(jsc ? 0 : 2);
    if (module._rxjit_set_shared_code) module._rxjit_set_shared_code(jsc ? 0 : 1);
    if (module._rxjit_set_aes_simd) module._rxjit_set_aes_simd(jsc ? 0 : 1);
    if (module._rxjit_set_kernel_k) module._rxjit_set_kernel_k(jsc ? 1 : 4);
  }
  if (typeof self !== 'undefined') self._rxjit_tier_probe_silent = true;
  if (module._rxjit_set_supjit_enabled) module._rxjit_set_supjit_enabled(1);
  module._rxSetJitEnabled(1);
  const eff = typeof module._rxjit_effective_fuse_n !== 'function'
    ? ''
    : ` fuse_n=${module._rxjit_effective_fuse_n()} triples_n=${module._rxjit_effective_triples_n?.()}` +
      ` unroll2=${module._rxjit_effective_unroll2?.()}` +
      (module._rxjit_effective_aes_simd ? ` aes_simd=${module._rxjit_effective_aes_simd()}` : '');
  return `JIT on (feature=${feature})${eff}`;
}

function seedHex() {
  return bytesToHex(seedBytes);
}

function bindHeap() {
  const heap = rx.module.HEAPU8;
  if (!heap) return;
  const buf = heap.buffer;
  rx.blob = new Uint8Array(buf, rx.blobPtr, 256);
  rx.seed = new Uint8Array(buf, rx.seedPtr, 32);
  rx.target = new Uint8Array(buf, rx.targetPtr, 8);
  rx.nonce = new Uint8Array(buf, rx.noncePtr, 4);
  rx.hash = new Uint8Array(buf, rx.hashPtr, 32);
  rx.found = new Int32Array(buf, rx.foundPtr, 1);
}

/* RandomX v1 known-answer test: seed = 32 zero bytes, blob = 76 zero bytes with
   nonce 01000000 little-endian at byte 39, hashed at height 1 (heights 0..2112
   all use the zero seed on Monero, so this is a call the miner really makes).
   086a612e...5f3 is what RandomX v1 returns for it: the wasm interpreter and the
   wasm JIT agree, and the same value comes out of the WebRandomX and bonanza
   builds, cross-checked against tevador's official test vector.

   Height 1, NOT 0 -- that is load-bearing. A shim that skips
   randomx_init_cache() when the request matches its zero-initialised cache
   state hashes a malloc'd-but-never-filled 256 MiB cache and returns a value
   that moves with the heap layout: that is what 30aed56e...c45c6f was (and
   MAX_THREADS 8 -> 32 turned it into 2f31bdb9...). A non-zero height forces the
   cache to be built, so this stays a real test of Argon2 + SuperscalarHash +
   hashing on every engine we ship. Do not "simplify" the call back to (0n, 0n).
   Returns '' when the engine hashes the vector correctly, else why it does not. */
const REFERENCE_HASH = '086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3';
function referenceVectorFailure() {
  try {
    const m = rx.module;
    const seedPtr = m._malloc(32), blobPtr = m._malloc(76), hashPtr = m._malloc(32);
    new Uint8Array(m.HEAPU8.buffer, seedPtr, 32).fill(0);
    const blob = new Uint8Array(m.HEAPU8.buffer, blobPtr, 76);
    blob.fill(0);
    blob[39] = 1;
    const ok = m._randomx_hash(1n, 1n, seedPtr, blobPtr, 76, hashPtr);
    const got = [...new Uint8Array(m.HEAPU8.buffer, hashPtr, 32)]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    try { m._free(seedPtr); m._free(blobPtr); m._free(hashPtr); } catch { /* ignore */ }
    if (!ok) return 'the wasm refused to hash';
    if (got !== REFERENCE_HASH) return `expected ${REFERENCE_HASH.slice(0, 16)}…, got ${got.slice(0, 16)}…`;
    return '';
  } catch (e) {
    return String((e && e.message) || e).slice(0, 120);
  }
}

function loadWasm() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    try {
      const res = await fetch(WASM_JS, { cache: 'no-store' });
      if (!res.ok) {
        if (USE_MT) throw new Error('pthread wasm missing (' + res.status + ')');
        throw new Error('no wasm js ' + res.status);
      }
      // Load the Emscripten glue as a worker script. importScripts() is a plain
      // same-origin script fetch: no eval, no string-as-code. That is what lets
      // the page run under `script-src 'self'` with no 'unsafe-eval'.
      const factory = await new Promise((resolve, reject) => {
        const prev = self.Module;
        try {
          self.importScripts(WASM_JS);
        } catch (err) {
          reject(err);
          return;
        }
        const cand = self.createWebRandomX || self.Module;
        if (typeof cand === 'function') resolve(cand);
        else reject(new Error('web-randomx.js did not export a Module factory'));
        self.Module = prev;
      });
      const module = await factory({
        locateFile(path) {
          const name = path.split('/').pop();
          return new URL('vendor/randomx/' + name + '?v=75', self.location).href;
        },
        mainScriptUrlOrBlob: WASM_JS,
      });
      if (typeof module._randomx_mine !== 'function') {
        throw new Error('_randomx_mine not exported');
      }
      const jitInfo = enableRandomXJit(module);
      rx = {
        module,
        mineFn: module._randomx_mine,
        hashFn: module._randomx_hash,
        setThreads: module._randomx_set_threads,
        isFull: module._randomx_is_full_mem,
        dsBegin: module._randomx_dataset_begin,
        dsStep: module._randomx_dataset_step,
        dsPct: module._randomx_dataset_percent,
        dsPtr: module._randomx_dataset_ptr,
        dsItems: module._randomx_dataset_items,
        dsItemBytes: module._randomx_dataset_item_bytes,
        dsMark: module._randomx_dataset_mark_ready,
        blobPtr: module._malloc(256),
        seedPtr: module._malloc(32),
        targetPtr: module._malloc(8),
        noncePtr: module._malloc(4),
        hashPtr: module._malloc(32),
        foundPtr: module._malloc(4),
      };
      bindHeap();
      if (typeof rx.setThreads === 'function') rx.setThreads(cpuThreads);
      /* Refuse to mine unless the engine reproduces the v1 reference vector.
         This is the only cheap way to catch a build that hashes with a
         different function — a core update that selects RandomX v2, say.
         verifySolved() cannot see it: it re-hashes with the same wrong
         function and reports success. Without this check the pool is the only
         thing that notices, one rejected share at a time. */
      const refFail = referenceVectorFailure();
      if (refFail) {
        postMessage({
          type: 'status',
          message: `Hash self-test failed (${refFail}). Refusing to mine — this build does not agree with the network's RandomX v1, so the pool would reject every share.`,
        });
        return false;
      }
      postMessage({
        type: 'status',
        message: (USE_MT
          ? `RandomX pthread Wasm loaded (${cpuThreads} C++ threads, one 2 GB dataset).`
          : 'RandomX sequential Wasm loaded (this origin cannot share the dataset).')
          + (jitInfo ? ` ${jitInfo}.` : ' JIT unavailable — running the interpreter.'),
      });
      return true;
    } catch (err) {
      rx = null;
      console.warn('RandomX Wasm not loaded:', err.message || err);
      return false;
    }
  })();
  return modulePromise;
}

let job = null;
let running = false;
let looping = false;
let blobBytes = new Uint8Array(0);
let seedBytes = new Uint8Array(0);
let targetBytes = new Uint8Array(4).fill(0xff);
let blobLen = 0;

function setJob(next) {
  const prevSeed = seedHex();
  job = next;
  if (!job || !job.blob) return;
  blobBytes = hexToBytes(job.blob);
  blobLen = blobBytes.length;
  seedBytes = hexToBytes(job.seed_hash);
  const t = hexToBytes(job.target);
  targetBytes = t.length >= 8 ? t.subarray(0, 8) : (t.length ? t : new Uint8Array(4).fill(0xff));
  const nextSeed = seedHex();
  if (prevSeed && nextSeed && prevSeed !== nextSeed) {
    dsGen += 1;
    lastPct = -1;
    cachedSeedHex = '';
    if (dsPhase === 'skip') return;
    dsPhase = 'try';
    postMessage({
      type: 'status',
      message: `seed_hash changed (${prevSeed.slice(0, 8)}… → ${nextSeed.slice(0, 8)}…). Dropping cached dataset.`,
    });
  }
}

function heightArgs() {
  return BigInt(job.height || 0);
}

/* Re-derive the result with the single-VM _randomx_hash before we tell the
   client to submit. The pthread mine path used to return a hash that did not
   belong to the nonce it reported (the wasm kept the FP rounding mode in a
   global, so concurrent VMs clobbered each other). The pool then rebuilt the
   blob, hashed our nonce, and answered "Low difficulty share" every time.
   One extra hash per share is cheap insurance against a silent regression. */
function verifySolved(nonceHex, resultHex, blobHex, seedHex, height) {
  if (!rx || typeof rx.hashFn !== 'function') return false;
  const blob = hexToBytes(blobHex);
  const nonce = hexToBytes(nonceHex);
  if (blob.length < 43 || nonce.length !== 4) return false;
  blob.set(nonce, 39);
  bindHeap();
  rx.blob.fill(0);
  rx.blob.set(blob.subarray(0, Math.min(blob.length, 256)));
  rx.seed.fill(0);
  rx.seed.set(hexToBytes(seedHex).subarray(0, 32));
  const h = BigInt(height || 0);
  const ok = rx.hashFn(h, h, rx.seedPtr, rx.blobPtr, blob.length, rx.hashPtr);
  bindHeap();
  return !!ok && bytesToHex(rx.hash) === resultHex;
}

function mineBatch(maxHashes) {
  if (!rx || !job || blobLen < 43) return { n: 0, solved: null };
  const hashedJobId = job.job_id;
  const hashedBlob = job.blob;
  bindHeap();
  rx.blob.fill(0);
  rx.blob.set(blobBytes.subarray(0, Math.min(blobLen, 256)));
  rx.seed.fill(0);
  if (seedBytes.length) rx.seed.set(seedBytes.subarray(0, Math.min(32, seedBytes.length)));
  rx.target.fill(0);
  rx.target.set(targetBytes.subarray(0, Math.min(8, targetBytes.length)));
  rx.found[0] = 0;

  const start = nonceBase;
  nonceBase = (nonceBase + maxHashes) >>> 0;
  const height = heightArgs();
  const n = rx.mineFn(
    height,
    height,
    rx.seedPtr,
    rx.blobPtr,
    blobLen,
    start,
    maxHashes,
    rx.targetPtr,
    targetBytes.length,
    rx.foundPtr,
    rx.noncePtr,
    rx.hashPtr,
  );
  bindHeap();
  if (job.job_id !== hashedJobId || job.blob !== hashedBlob) {
    return { n: n | 0, solved: null };
  }
  const solved = rx.found[0]
    ? { nonceHex: bytesToHex(rx.nonce), result: bytesToHex(rx.hash), job_id: hashedJobId }
    : null;
  if (solved && !verifySolved(solved.nonceHex, solved.result, hashedBlob, job.seed_hash, job.height)) {
    postMessage({
      type: 'status',
      message: 'Mining self-check failed: the wasm result is not the hash of its own nonce, so the pool would reject it. Share dropped. Rebuild web-randomx-mt (thread-local rounding mode).',
    });
    return { n: n | 0, solved: null };
  }
  return { n: n | 0, solved };
}

function tryDatasetBegin() {
  if (!rx || !rx.dsBegin || !job) return false;
  bindHeap();
  rx.seed.fill(0);
  if (seedBytes.length) rx.seed.set(seedBytes.subarray(0, Math.min(32, seedBytes.length)));
  const height = heightArgs();
  try {
    const ok = rx.dsBegin(height, height, rx.seedPtr);
    bindHeap();
    return !!ok;
  } catch (err) {
    console.warn('dataset begin failed', err.message || err);
    bindHeap();
    return false;
  }
}

function datasetStep() {
  bindHeap();
  try {
    const pct = rx.dsStep(DS_CHUNK);
    bindHeap();
    return pct | 0;
  } catch (err) {
    console.warn('dataset step failed', err.message || err);
    bindHeap();
    return -1;
  }
}

function datasetByteLength() {
  bindHeap();
  const items = rx.dsItems ? rx.dsItems() | 0 : 0;
  const b = rx.dsItemBytes ? rx.dsItemBytes() | 0 : 64;
  return items * b;
}

function datasetView() {
  bindHeap();
  const ptr = rx.dsPtr ? rx.dsPtr() | 0 : 0;
  const len = datasetByteLength();
  if (!ptr || len <= 0) return null;
  return new Uint8Array(rx.module.HEAPU8.buffer, ptr, len);
}

async function opfsDir() {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function dropOtherSeeds(keepHex) {
  try {
    const dir = await opfsDir();
    if (!dir) return;
    const keep = `${keepHex}.bin`;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (name !== keep) {
        await dir.removeEntry(name);
      }
    }
  } catch (err) {
    console.warn('opfs drop failed', err.message || err);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label + ' timed out')), ms);
    }),
  ]);
}

async function restoreFromOpfs(gen) {
  const hex = seedHex();
  if (!hex || hex.length < 16) return false;
  try {
    const dir = await withTimeout(opfsDir(), OPFS_BUDGET_MS, 'OPFS');
    if (!dir) {
      postMessage({ type: 'status', message: 'OPFS not available — filling dataset in this tab.' });
      return false;
    }
    let fh;
    try {
      fh = await withTimeout(dir.getFileHandle(`${hex}.bin`), OPFS_BUDGET_MS, 'OPFS open');
    } catch {
      postMessage({ type: 'status', message: 'No cached dataset for this seed — filling (~6 min once).' });
      return false;
    }
    const file = await fh.getFile();
    const expect = datasetByteLength();
    if (!expect || file.size !== expect) {
      postMessage({
        type: 'status',
        message: `Cached dataset size mismatch (${file.size} vs ${expect}) — refilling.`,
      });
      try { await dir.removeEntry(`${hex}.bin`); } catch { /* ignore */ }
      return false;
    }
    postMessage({ type: 'status', message: 'Restoring ~2 GB dataset from disk…' });
    const acc = await fh.createSyncAccessHandle();
    try {
      let off = 0;
      let last = -1;
      const tmp = new Uint8Array(IO_CHUNK);
      while (off < expect) {
        if (gen !== dsGen) return false;
        const n = Math.min(IO_CHUNK, expect - off);
        const got = acc.read(tmp.subarray(0, n), { at: off });
        const view = datasetView();
        if (!view) return false;
        view.set(tmp.subarray(0, got), off);
        off += got;
        const pct = Math.floor((off * 100) / expect);
        if (pct !== last) {
          last = pct;
          postMessage({ type: 'ds', pct });
        }
      }
    } finally {
      acc.close();
    }
    if (gen !== dsGen) return false;
    bindHeap();
    if (!rx.dsMark || !rx.dsMark()) return false;
    cachedSeedHex = hex;
    return true;
  } catch (err) {
    console.warn('opfs restore failed', err.message || err);
    postMessage({ type: 'status', message: `OPFS restore failed (${err.message || err}) — filling.` });
    return false;
  }
}

async function saveToOpfs(gen) {
  const hex = seedHex();
  if (!hex || hex.length < 16) return;
  try {
    const dir = await opfsDir();
    if (!dir) return;
    await dropOtherSeeds(hex);
    const view = datasetView();
    if (!view) return;
    postMessage({ type: 'status', message: 'Saving dataset to this browser (next Start skips the 6 min fill)…' });
    const fh = await dir.getFileHandle(`${hex}.bin`, { create: true });
    const acc = await fh.createSyncAccessHandle();
    try {
      acc.truncate(0);
      let off = 0;
      let last = -1;
      while (off < view.byteLength) {
        if (gen !== dsGen) return;
        const n = Math.min(IO_CHUNK, view.byteLength - off);
        const v = datasetView();
        if (!v) return;
        acc.write(v.subarray(off, off + n), { at: off });
        off += n;
        const pct = Math.floor((off * 100) / view.byteLength);
        if (pct !== last) {
          last = pct;
          postMessage({ type: 'status', message: `Saving dataset ${pct}%` });
        }
      }
      acc.flush();
    } finally {
      acc.close();
    }
    cachedSeedHex = hex;
    postMessage({ type: 'status', message: 'Dataset cached in this browser until seed_hash changes (~2.8 days).' });
  } catch (err) {
    console.warn('opfs save failed', err.message || err);
    postMessage({ type: 'status', message: `Could not cache dataset (${err.message || err}). Next visit will refill.` });
  }
}

function markFullReady(how) {
  dsPhase = 'done';
  lastPct = 100;
  postMessage({ type: 'ds', pct: 100 });
  postMessage({ type: 'dataset', full: true, ms: 0, n: 0 });
  postMessage({
    type: 'status',
    message: how === 'opfs'
      ? 'RandomX fast/full dataset restored from disk. Hashing with full mem.'
      : 'RandomX fast/full dataset ready. Hashing with full mem.',
  });
}

function scheduleLoop(ms) {
  if (!running) {
    looping = false;
    return;
  }
  looping = true;
  setTimeout(loop, ms || 0);
}

function kickLoop() {
  if (!running || looping) return;
  scheduleLoop(0);
}

function loop() {
  looping = true;
  if (!running || !job) {
    looping = false;
    return;
  }
  if (!rx) {
    scheduleLoop(1500);
    return;
  }

  if (!lightReady) {
    const tInit = performance.now();
    const first = mineBatch(1);
    lightReady = true;
    postMessage({
      type: 'dataset',
      full: false,
      ms: Math.round(performance.now() - tInit),
      n: first.n,
    });
    // Only allocate the ~2.5 GB dataset when the reader opted in. Otherwise
    // stay on the light cache for the whole session (the previous behaviour,
    // to grab it by default, is what made a first Start a 6-minute memory
    // spike nobody asked for).
    dsPhase = fullDataset ? 'try' : 'skip';
    if (!fullDataset) {
      postMessage({
        type: 'status',
        message: 'Mining in light/cache mode. Tick “Fast mode — ~2.5 GB dataset” before Start for full-dataset speed.',
      });
    }
    scheduleLoop(0);
    return;
  }

  if (dsPhase === 'try') {
    postMessage({ type: 'status', message: 'Trying ~2 GB dataset alloc. Tab stays in light mode if this fails.' });
    const ok = tryDatasetBegin();
    if (!ok) {
      dsPhase = 'skip';
      postMessage({ type: 'status', message: 'Dataset alloc failed — staying in light/cache. Fast mode needs ~3 GB free in this tab (Chrome, 16 GB PC).' });
      scheduleLoop(0);
      return;
    }
    const gen = dsGen;
    dsPhase = 'filling';
    lastPct = -1;
    postMessage({ type: 'ds', pct: 0 });
    postMessage({ type: 'status', message: 'Dataset allocated. Filling in chunks (progress below). Hashing pauses until 100%.' });
    withTimeout(restoreFromOpfs(gen), OPFS_BUDGET_MS, 'OPFS restore').then((hit) => {
      if (gen !== dsGen) return;
      if (hit && dsPhase === 'filling') {
        markFullReady('opfs');
        scheduleLoop(0);
      }
    }).catch(() => {
      /* miss or timeout — fill already running */
    });
    scheduleLoop(0);
    return;
  }

  if (dsPhase === 'filling') {
    const t0 = performance.now();
    let pct = lastPct;
    let stepped = false;
    while (performance.now() - t0 < 500) {
      pct = datasetStep();
      stepped = true;
      if (pct < 0) {
        dsPhase = 'skip';
        postMessage({ type: 'status', message: 'Dataset fill aborted — staying in light/cache.' });
        break;
      }
      if (pct !== lastPct || lastPct < 0) {
        lastPct = pct;
        postMessage({ type: 'ds', pct: Math.max(0, pct) });
      }
      if (pct >= 100) {
        const gen = dsGen;
        dsPhase = 'saving';
        saveToOpfs(gen).then(() => {
          if (gen !== dsGen) {
            dsPhase = 'try';
          } else {
            markFullReady('fill');
          }
          scheduleLoop(0);
        });
        return;
      }
    }
    scheduleLoop(0);
    return;
  }

  if (dsPhase === 'saving') {
    looping = false;
    return;
  }

  if (!hashing) {
    scheduleLoop(250);
    return;
  }

  const t0 = performance.now();
  let n = 0;
  let solved = null;
  const batch = dsPhase === 'done' ? Math.max(64, cpuThreads * 32) : 4;
  try {
    while (performance.now() - t0 < 800) {
      const r = mineBatch(batch);
      n += r.n;
      if (r.solved) { solved = r.solved; break; }
      if (!r.n) break;
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (isPthreadNoise(msg)) {
      /* ignore */
    } else {
      hashing = false;
      postMessage({ type: 'status', message: `Hash loop stopped: ${msg.slice(0, 160)}` });
      return;
    }
  }
  if (n) postMessage({ type: 'hashes', n });
  if (solved) {
    postMessage({
      type: 'solved',
      job_id: solved.job_id,
      nonce: solved.nonceHex,
      result: solved.result,
    });
  }
  scheduleLoop(0);
}

onmessage = function (e) {
  const data = e.data || {};
  if (data.type === 'config') {
    const want = data.fullDataset === true;
    if (want !== fullDataset) {
      fullDataset = want;
      // The opt-in is a per-start decision, but this worker outlives stop() (paused,
      // not terminated). The decision is taken inside `if (!lightReady)` -- a
      // once-per-worker latch -- so resetting dsPhase alone would not re-decide it.
      // Clear both, so the next loop iteration re-evaluates the opt-in. Never while
      // a build/save is in flight.
      if (dsPhase === 'skip' || dsPhase === 'idle') {
        dsPhase = 'idle';
        lightReady = false;
      }
    }
  }
  if (data.type === 'threads') {
    cpuThreads = Math.max(1, Math.min(32, data.n | 0 || 1));
    if (rx && typeof rx.setThreads === 'function') rx.setThreads(cpuThreads);
    postMessage({ type: 'status', message: `C++ threads set to ${cpuThreads} (shared dataset).` });
  }
  if (data.type === 'job') {
    setJob(data.job);
    if (!running) {
      running = true;
      loadWasm().then((ok) => {
        postMessage({ type: 'ready', wasm: ok });
        kickLoop();
      });
    } else {
      kickLoop();
    }
  }
  if (data.type === 'pause') {
    hashing = false;
    postMessage({
      type: 'status',
      message: dsPhase === 'filling' || dsPhase === 'saving' || dsPhase === 'try'
        ? 'Mining paused. Dataset fill continues (no hashes until we reconnect).'
        : 'Mining paused (dataset kept).',
    });
  }
  if (data.type === 'resume') {
    hashing = true;
    running = true;
    kickLoop();
  }
  if (data.type === 'stop') {
    running = false;
    hashing = false;
  }
};

loadWasm().then((ok) => postMessage({ type: 'ready', wasm: ok }));
