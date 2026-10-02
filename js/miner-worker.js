/* RandomX hash worker (experimental).

   JIT is not available in Wasm (CompiledVm::execute is empty).
   Light/cache hashes immediately. Then we allocate the ~2 GB dataset and
   either restore it from OPFS (keyed by seed_hash) or fill it in C++
   chunks. A seed change drops the old file and rebuilds. */

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

function seedHex() {
  return bytesToHex(seedBytes);
}

function bindHeap() {
  const heap = rx.module.HEAPU8;
  rx.blob = new Uint8Array(heap.buffer, rx.blobPtr, 256);
  rx.seed = new Uint8Array(heap.buffer, rx.seedPtr, 32);
  rx.target = new Uint8Array(heap.buffer, rx.targetPtr, 8);
  rx.nonce = new Uint8Array(heap.buffer, rx.noncePtr, 4);
  rx.hash = new Uint8Array(heap.buffer, rx.hashPtr, 32);
  rx.found = new Int32Array(heap.buffer, rx.foundPtr, 1);
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
      const src = await res.text();
      const factory = await new Promise((resolve, reject) => {
        const prev = self.Module;
        try {
          (0, eval)(src + '\n//# sourceURL=web-randomx.js');
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
          return new URL('vendor/randomx/' + name, self.location).href;
        },
        mainScriptUrlOrBlob: WASM_JS,
      });
      if (typeof module._randomx_mine !== 'function') {
        throw new Error('_randomx_mine not exported');
      }
      rx = {
        module,
        mineFn: module._randomx_mine,
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
      postMessage({
        type: 'status',
        message: USE_MT
          ? `RandomX pthread Wasm loaded (${cpuThreads} C++ threads, one 2 GB dataset).`
          : 'RandomX sequential Wasm loaded (this origin cannot share the dataset).',
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
  targetBytes = t.length ? t : new Uint8Array(4).fill(0xff);
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

function mineBatch(maxHashes) {
  if (!rx || !job || blobLen < 43) return { n: 0, solved: null };
  const hashedJobId = job.job_id;
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
  const solved = rx.found[0]
    ? { nonceHex: bytesToHex(rx.nonce), result: bytesToHex(rx.hash), job_id: hashedJobId }
    : null;
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

function loop() {
  if (!running || !job) return;
  if (!rx) {
    setTimeout(loop, 1500);
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
    dsPhase = 'try';
    if (running) setTimeout(loop, 0);
    return;
  }

  if (dsPhase === 'try') {
    postMessage({ type: 'status', message: 'Trying ~2 GB dataset alloc. Tab stays in light mode if this fails.' });
    const ok = tryDatasetBegin();
    if (!ok) {
      dsPhase = 'skip';
      postMessage({ type: 'status', message: 'Dataset alloc failed — staying in light/cache. Fast mode needs ~3 GB free in this tab (Chrome, 16 GB PC).' });
      if (running) setTimeout(loop, 0);
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
        if (running) setTimeout(loop, 0);
      }
    }).catch(() => {
      /* miss or timeout — fill already running */
    });
    if (running) setTimeout(loop, 0);
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
          if (running) setTimeout(loop, 0);
        });
        return;
      }
    }
    if (running) setTimeout(loop, 0);
    return;
  }

  if (dsPhase === 'saving') return;

  if (!hashing) {
    if (running) setTimeout(loop, 250);
    return;
  }

  const t0 = performance.now();
  let n = 0;
  let solved = null;
  const batch = dsPhase === 'done' ? 8 : 4;
  while (performance.now() - t0 < 400) {
    const r = mineBatch(batch);
    n += r.n;
    if (r.solved) { solved = r.solved; break; }
    if (!r.n) break;
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
  if (running) setTimeout(loop, 0);
}

onmessage = function (e) {
  const data = e.data || {};
  if (data.type === 'threads') {
    cpuThreads = Math.max(1, Math.min(8, data.n | 0 || 1));
    if (rx && typeof rx.setThreads === 'function') rx.setThreads(cpuThreads);
    postMessage({ type: 'status', message: `C++ threads set to ${cpuThreads} (shared dataset).` });
  }
  if (data.type === 'job') {
    setJob(data.job);
    if (!running) {
      running = true;
      loadWasm().then((ok) => {
        postMessage({ type: 'ready', wasm: ok });
        loop();
      });
    } else if (dsPhase === 'try' || dsPhase === 'idle') {
      loop();
    }
  }
  if (data.type === 'pause') {
    hashing = false;
    postMessage({
      type: 'status',
      message: dsPhase === 'done'
        ? 'Hashing paused. Dataset kept in this tab.'
        : 'Hashing paused (dataset fill continues if in progress).',
    });
  }
  if (data.type === 'resume') {
    hashing = true;
    if (!running) {
      running = true;
      loop();
    } else {
      loop();
    }
  }
  if (data.type === 'stop') {
    running = false;
    hashing = false;
  }
};

loadWasm().then((ok) => postMessage({ type: 'ready', wasm: ok }));
