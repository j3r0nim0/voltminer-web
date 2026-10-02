/* RandomX hash worker (experimental).

   JIT is not available in Wasm (CompiledVm::execute is empty).
   We hash in light/cache immediately, then try to fill the ~2 GB
   dataset in small C++ chunks so the worker can yield and the tab
   stays alive. If alloc fails, we stay in light mode. */

const WASM_JS = new URL('vendor/randomx/web-randomx.js', self.location).href;
const DS_CHUNK = 131072; // ~8 MB of dataset items per step

let modulePromise = null;
let rx = null;
let nonceBase = (Math.random() * 0x100000000) >>> 0;
let lightReady = false;
let dsPhase = 'idle'; // idle | filling | done | skip
let lastPct = -1;

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
      if (!res.ok) throw new Error('no wasm js ' + res.status);
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
          const name = path.endsWith('.wasm') ? 'web-randomx.wasm' : path;
          return new URL('vendor/randomx/' + name, self.location).href;
        },
      });
      if (typeof module._randomx_mine !== 'function') {
        throw new Error('_randomx_mine not exported');
      }
      rx = {
        module,
        mineFn: module._randomx_mine,
        isFull: module._randomx_is_full_mem,
        dsBegin: module._randomx_dataset_begin,
        dsStep: module._randomx_dataset_step,
        dsPct: module._randomx_dataset_percent,
        blobPtr: module._malloc(256),
        seedPtr: module._malloc(32),
        targetPtr: module._malloc(8),
        noncePtr: module._malloc(4),
        hashPtr: module._malloc(32),
        foundPtr: module._malloc(4),
      };
      bindHeap();
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
  job = next;
  if (!job || !job.blob) return;
  blobBytes = hexToBytes(job.blob);
  blobLen = blobBytes.length;
  seedBytes = hexToBytes(job.seed_hash);
  const t = hexToBytes(job.target);
  targetBytes = t.length ? t : new Uint8Array(4).fill(0xff);
}

function heightArgs() {
  const height = BigInt(job.height || 0);
  return height;
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
    postMessage({ type: 'status', message: 'Trying ~2 GB dataset alloc (chunked). Tab will keep hashing if this fails.' });
    const ok = tryDatasetBegin();
    if (!ok) {
      dsPhase = 'skip';
      postMessage({ type: 'status', message: 'Dataset alloc failed — staying in light/cache. Fast mode needs ~3 GB free in this tab (Chrome, 16 GB PC).' });
    } else {
      dsPhase = 'filling';
      postMessage({ type: 'status', message: 'Dataset allocated. Filling in chunks (progress below). Hashing pauses until 100%.' });
    }
    if (running) setTimeout(loop, 0);
    return;
  }

  if (dsPhase === 'filling') {
    const t0 = performance.now();
    let pct = lastPct;
    while (performance.now() - t0 < 350) {
      pct = datasetStep();
      if (pct < 0) {
        dsPhase = 'skip';
        postMessage({ type: 'status', message: 'Dataset fill aborted — staying in light/cache.' });
        break;
      }
      if (pct !== lastPct) {
        lastPct = pct;
        postMessage({ type: 'ds', pct });
      }
      if (pct >= 100) {
        dsPhase = 'done';
        postMessage({
          type: 'dataset',
          full: true,
          ms: 0,
          n: 0,
        });
        postMessage({ type: 'status', message: 'RandomX fast/full dataset ready. Hashing with full mem.' });
        break;
      }
    }
    if (running) setTimeout(loop, 0);
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
  if (data.type === 'job') {
    setJob(data.job);
    if (!running) {
      running = true;
      loadWasm().then((ok) => {
        postMessage({ type: 'ready', wasm: ok });
        loop();
      });
    }
  }
  if (data.type === 'pause') {
    running = false;
  }
  if (data.type === 'resume') {
    if (!running) {
      running = true;
      loop();
    }
  }
  if (data.type === 'stop') running = false;
};

loadWasm().then((ok) => postMessage({ type: 'ready', wasm: ok }));
