/* mine-vs-hash test inside a dedicated worker (pthread build needs Atomics.wait,
   which the page main thread forbids). Mirrors miner-worker.js plumbing. */
const SEED = '427164010fb682d0b40f88c78427b40a4cec9712b21c51c42ae8a6c955d2dca1';
const BLOB = '1010d083ffd506f915d344a68aa9181fc720ba4f7b8f0d9828167736d64f9fc227a98d33b0b3940000000086d42a145f6bb688651418686b3c9703c1fc633ec0a1ec93dfa7d844ad12b87453';
const HEIGHT = 3775316n;

const USE_MT = typeof SharedArrayBuffer === 'function';
const WASM_JS = new URL(USE_MT ? 'js/vendor/randomx/web-randomx-mt.js' : 'js/vendor/randomx/web-randomx.js', self.location).href;

function hexToBytes(hex) {
  const h = String(hex).replace(/[^0-9a-f]/gi, '');
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

let rx = null;
function bindHeap() {
  const buf = rx.module.HEAPU8.buffer;
  rx.blob = new Uint8Array(buf, rx.blobPtr, 256);
  rx.seed = new Uint8Array(buf, rx.seedPtr, 32);
  rx.target = new Uint8Array(buf, rx.targetPtr, 8);
  rx.nonce = new Uint8Array(buf, rx.noncePtr, 4);
  rx.hash = new Uint8Array(buf, rx.hashPtr, 32);
  rx.found = new Int32Array(buf, rx.foundPtr, 1);
}

async function loadWasm() {
  const res = await fetch(WASM_JS, { cache: 'no-store' });
  const src = await res.text();
  const prev = self.Module;
  const factory = await new Promise((resolve, reject) => {
    try { (0, eval)(src + '\n//# sourceURL=web-randomx.js'); } catch (e) { reject(e); return; }
    const cand = self.createWebRandomX || self.Module;
    if (typeof cand === 'function') resolve(cand); else reject(new Error('no factory'));
    self.Module = prev;
  });
  const module = await factory({
    locateFile(p) { return new URL('js/vendor/randomx/' + p.split('/').pop() + '?v=50', self.location).href; },
    mainScriptUrlOrBlob: WASM_JS,
  });
  rx = {
    module,
    mineFn: module._randomx_mine,
    hashFn: module._randomx_hash,
    setThreads: module._randomx_set_threads,
    blobPtr: module._malloc(256),
    seedPtr: module._malloc(32),
    targetPtr: module._malloc(8),
    noncePtr: module._malloc(4),
    hashPtr: module._malloc(32),
    foundPtr: module._malloc(4),
  };
  bindHeap();
}

function put(seed, blob, target, start) {
  bindHeap();
  rx.seed.fill(0); rx.seed.set(seed.subarray(0, 32));
  rx.blob.fill(0); rx.blob.set(blob.subarray(0, 256));
  rx.target.fill(0); rx.target.set(target.subarray(0, 8));
  rx.found[0] = 0;
  return start >>> 0;
}

function hashFixedNonce(seed, blob, nonceLe) {
  const b = blob.slice();
  b.set(nonceLe, 39);
  put(seed, b, new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0);
  const ok = rx.hashFn(HEIGHT, HEIGHT, rx.seedPtr, rx.blobPtr, b.length, rx.hashPtr);
  bindHeap();
  return { ok, hash: bytesToHex(rx.hash), blobHex: bytesToHex(b) };
}

function mine(seed, blob, target, start, max, threads) {
  rx.setThreads(threads);
  put(seed, blob, target, start);
  const t0 = performance.now();
  const n = rx.mineFn(
    HEIGHT, HEIGHT, rx.seedPtr, rx.blobPtr, blob.length,
    start, max, rx.targetPtr, target.length, rx.foundPtr, rx.noncePtr, rx.hashPtr,
  );
  const ms = performance.now() - t0;
  bindHeap();
  return {
    n: n | 0, ms: Math.round(ms), found: rx.found[0],
    nonce: rx.found[0] ? bytesToHex(rx.nonce) : null,
    result: rx.found[0] ? bytesToHex(rx.hash) : null,
  };
}

const seed = hexToBytes(SEED);
const blob = hexToBytes(BLOB);
const lines = [];
const say = (s) => { lines.push(s); postMessage({ type: 'log', text: lines.join('\n') }); };

(async () => {
  await loadWasm();
  say('loaded mt=' + USE_MT);
  const all = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const real = hexToBytes('b88d0600');
  const cases = [
    ['T1 th=1 target=ffffffff max=1', 1, all, 0x00000001, 1],
    ['T2 th=2 target=ffffffff max=64', 2, all, 0x00000001, 64],
    ['T3 th=4 target=ffffffff max=128', 4, all, 0x11223344, 128],
    ['T4 th=2 target=ffffffff max=1', 2, all, 0xaabbccdd, 1],
    ['T5 th=2 target=ffffffff max=100', 2, all, 0xdeadbeef, 100],
    ['T6 th=3 target=b88d0600 real10k max=300000', 3, real, 0x5a5a5a5a, 300000],
    ['T7 th=1 target=b88d0600 real10k max=300000', 1, real, 0x0badf00d, 300000],
  ];
  const results = [];
  for (const [label, th, target, start, max] of cases) {
    const m = mine(seed, blob, target, start, max, th);
    if (!m.found) { say(`${label}: n=${m.n} ${m.ms}ms found=0 (no solution)`); results.push({ label, ...m, match: null }); continue; }
    const nonceLe = hexToBytes(m.nonce);
    const h = hashFixedNonce(seed, blob, nonceLe);
    const expectNonce = new Uint8Array([start & 0xff, (start >>> 8) & 0xff, (start >>> 16) & 0xff, (start >>> 24) & 0xff]);
    const ok = m.result === h.hash;
    results.push({ label, ...m, expectNonce: bytesToHex(expectNonce), hashOfNonce: h.hash, match: ok });
    say(`${label}\n  n=${m.n} ${m.ms}ms nonce=${m.nonce} (exp ${bytesToHex(expectNonce)})\n  mine =${m.result}\n  hash =${h.hash}\n  MATCH ${ok ? 'YES' : 'NO'}`);
  }
  const fx0 = hashFixedNonce(seed, blob, new Uint8Array([0, 0, 0, 0]));
  const fx1 = hashFixedNonce(seed, blob, new Uint8Array([0xdd, 0xcc, 0xbb, 0xaa]));
  say('native nonce=00000000 hash=' + fx0.hash);
  say('native nonce=ddccbbaa hash=' + fx1.hash);
  postMessage({ type: 'done', results, fixed0: fx0.hash, fixedDdcc: fx1.hash, blobHex: fx0.blobHex });
})().catch((e) => postMessage({ type: 'done', error: String(e && e.stack || e) }));
