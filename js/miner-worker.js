/* RandomX hash worker (experimental).

   If js/vendor/randomx/web-randomx.js is present, we load it and call
   `_randomx_hash` (WebRandomX / tevador RandomX, light/cache mode).
   If not, we still speak the job protocol so the UI and bridge can be
   tested; we never submit fake shares.

   Share check matches XMRig/MoneroOcean: the first 8 bytes of the hash
   as a little-endian uint64 must be <= the job target. Comparing from
   the high end of the 32-byte hash never hits a 4-byte MO target. */

const WASM_JS = new URL('vendor/randomx/web-randomx.js', self.location).href;

let modulePromise = null;
let rx = null;
let nonceBase = (Math.random() * 0x100000000) >>> 0;
let debugOnce = false;

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

/** XMRig Job::checkHash — first 8 bytes of hash as LE uint64 <= target. */
function meetsTarget(output, target) {
  if (!target.length) return false;
  let tmp = 0;
  const n = Math.min(4, target.length);
  for (let i = 0; i < n; i++) tmp |= target[i] << (8 * i);
  tmp >>>= 0;
  if (tmp === 0) {
    if (target.length >= 8) {
      let h = 0n;
      let t = 0n;
      for (let i = 0; i < 8; i++) {
        h |= BigInt(output[i]) << BigInt(8 * i);
        t |= BigInt(target[i]) << BigInt(8 * i);
      }
      return h <= t;
    }
    return false;
  }
  const t64 = 0xFFFFFFFFFFFFFFFFn / (0xFFFFFFFFn / BigInt(tmp));
  let h = 0n;
  for (let i = 0; i < 8; i++) h |= BigInt(output[i]) << BigInt(8 * i);
  return h <= t64;
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
      const hashFn = module._randomx_hash;
      if (typeof hashFn !== 'function') throw new Error('_randomx_hash not exported');
      const input = new Uint8Array(module.HEAPU8.buffer, module._malloc(256), 256);
      const output = new Uint8Array(module.HEAPU8.buffer, module._malloc(32), 32);
      const seed = new Uint8Array(module.HEAPU8.buffer, module._malloc(32), 32);
      rx = { module, hashFn, input, output, seed };
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
let targetBytes = new Uint8Array(4).fill(0xff);

function setJob(next) {
  job = next;
  if (!job || !job.blob) return;
  const t = hexToBytes(job.target);
  targetBytes = t.length ? t : new Uint8Array(4).fill(0xff);
}

function hashOnce() {
  if (!rx || !job) return null;
  const blob = hexToBytes(job.blob);
  if (blob.length < 43) return null;
  rx.input.fill(0);
  rx.input.set(blob.subarray(0, Math.min(blob.length, rx.input.length)));
  const seed = hexToBytes(job.seed_hash);
  rx.seed.fill(0);
  if (seed.length) rx.seed.set(seed.subarray(0, Math.min(32, seed.length)));

  nonceBase = (nonceBase + 1) >>> 0;
  const nonce = nonceBase;
  rx.input[39] = (nonce >>> 24) & 0xff;
  rx.input[40] = (nonce >>> 16) & 0xff;
  rx.input[41] = (nonce >>> 8) & 0xff;
  rx.input[42] = nonce & 0xff;

  const height = BigInt(job.height || 0);
  rx.hashFn(height, height, rx.seed.byteOffset, rx.input.byteOffset, blob.length, rx.output.byteOffset);

  const nonceHex = bytesToHex(rx.input.subarray(39, 43));
  const result = bytesToHex(rx.output.subarray(0, 32));
  const ok = meetsTarget(rx.output.subarray(0, 32), targetBytes);
  if (!debugOnce) {
    debugOnce = true;
    postMessage({
      type: 'debug',
      nonceHex,
      result,
      target: job.target,
      ok,
      h64: bytesToHex(rx.output.subarray(0, 8)),
    });
    // One probe share: pool says "low difficulty" (hash OK) vs "invalid" (wasm wrong).
    postMessage({
      type: 'probe',
      job_id: job.job_id,
      nonce: nonceHex,
      result,
    });
  }
  return { nonceHex, result, ok };
}

function loop() {
  if (!running || !job) return;
  if (!rx) {
    setTimeout(loop, 1500);
    return;
  }
  const t0 = performance.now();
  let n = 0;
  let solved = null;
  while (performance.now() - t0 < 250) {
    const r = hashOnce();
    n += 1;
    if (r && r.ok) { solved = r; break; }
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
