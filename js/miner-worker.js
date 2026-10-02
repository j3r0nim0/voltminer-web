/* RandomX hash worker (experimental).

   Fast/full-dataset interpreted RandomX in Wasm. JIT is not available
   in the browser (CompiledVm::execute is empty). The inner nonce loop
   runs in C++ (`_randomx_mine`) so JS is not on the hash path.

   First call builds the ~2 GB dataset (1–3 min). Extra workers would
   each allocate another 2 GB — the page runs exactly one. */

const WASM_JS = new URL('vendor/randomx/web-randomx.js', self.location).href;

let modulePromise = null;
let rx = null;
let nonceBase = (Math.random() * 0x100000000) >>> 0;
let datasetReady = false;

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
      const mineFn = module._randomx_mine;
      const hashFn = module._randomx_hash;
      if (typeof mineFn !== 'function' && typeof hashFn !== 'function') {
        throw new Error('_randomx_mine/_randomx_hash not exported');
      }
      rx = {
        module,
        mineFn,
        hashFn,
        isFull: module._randomx_is_full_mem,
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

function mineBatch(maxHashes) {
  if (!rx || !job || blobLen < 43) return { n: 0, solved: null };
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
  const height = BigInt(job.height || 0);
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
    ? { nonceHex: bytesToHex(rx.nonce), result: bytesToHex(rx.hash) }
    : null;
  return { n: n | 0, solved };
}

function loop() {
  if (!running || !job) return;
  if (!rx) {
    setTimeout(loop, 1500);
    return;
  }
  if (!datasetReady) {
    postMessage({ type: 'status', message: 'Building RandomX dataset (~2 GB). First hash can take 1–3 minutes. Do not close the tab.' });
    const tInit = performance.now();
    mineBatch(1);
    bindHeap();
    const full = rx.isFull ? !!rx.isFull() : false;
    datasetReady = true;
    postMessage({
      type: 'dataset',
      full,
      ms: Math.round(performance.now() - tInit),
    });
    if (running) setTimeout(loop, 0);
    return;
  }
  const t0 = performance.now();
  let n = 0;
  let solved = null;
  while (performance.now() - t0 < 400) {
    const r = mineBatch(4);
    n += r.n;
    if (r.solved) { solved = r.solved; break; }
    if (!r.n) break;
  }
  if (n) postMessage({ type: 'hashes', n });
  if (solved) {
    postMessage({
      type: 'solved',
      job_id: job.job_id,
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
  if (data.type === 'stop') running = false;
};

loadWasm().then((ok) => postMessage({ type: 'ready', wasm: ok }));
