/* Browser miner client — experimental RandomX path.

   Browser  --WS/WSS-->  origin-locked VPS bridge  --TLS-->  gulf.moneroocean.stream:20032

   Speaks standard stratum JSON-RPC (login / job / submit), not the dead
   webminerpool.com handshake. No Cloudflare Worker is in this path. */

export const POOL_NAME = 'gulf.moneroocean.stream:20032';

/** Production bridge URL (DigitalOcean VPS, not Cloudflare). */
export const PROD_BRIDGE_WS = 'wss://bridge.voltminer.net';

export function defaultBridgeUrl() {
  try {
    const override = localStorage.getItem('voltminer.web.bridgeWs');
    if (override && /^wss?:\/\//i.test(override)) return override;
  } catch { /* private mode */ }
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host === 'localhost' || host === '127.0.0.1') return 'ws://127.0.0.1:8787';
  return PROD_BRIDGE_WS;
}

export function isValidWallet(address) {
  const s = String(address || '').trim();
  const b58 = '[1-9A-HJ-NP-Za-km-z]';
  return new RegExp(`^(?:[48]${b58}{94}|4${b58}{105})$`).test(s);
}

export function hardwareThreads() {
  const n = Number(navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(32, n));
}

export function defaultThreadCount() {
  const max = hardwareThreads();
  return Math.max(1, Math.min(max - 1, Math.floor(max / 2)));
}

export function loadOrCreateWorkerId() {
  const key = 'voltminer.web.workerId';
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^VMW-[0-9a-f]{8}$/i.test(existing)) return existing;
  } catch { /* private mode */ }
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const id = 'VMW-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(key, id); } catch { /* ignore */ }
  return id;
}

export class MinerClient {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.ws = null;
    this.workers = [];
    this.job = null;
    this.connected = false;
    this.wantRun = false;
    this.reconnectTimer = null;
    this.statsTimer = null;
    this.rpcId = 1;
    this.loginId = null;
    this.submitIds = new Map();
    this.sessionId = null;
    this.wallet = '';
    this.password = 'x';
    this.threads = 1;
    this.bridgeUrl = '';
    this.totalHashes = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.windowHashes = 0;
    this.hashrate = 0;
    this.wasmReady = false;
    this.pingTimer = null;
  }

  #emit(type, detail) {
    this.onEvent({ type, ...detail, stats: this.snapshot() });
  }

  snapshot() {
    return {
      connected: this.connected,
      running: this.wantRun,
      threads: this.workers.length,
      hashrate: this.hashrate,
      totalHashes: this.totalHashes,
      accepted: this.accepted,
      rejected: this.rejected,
      wasmReady: this.wasmReady,
    };
  }

  start({ wallet, password, threads, bridgeUrl }) {
    if (!isValidWallet(wallet)) throw new Error('Invalid Monero address');
    const url = bridgeUrl || defaultBridgeUrl();
    if (!url) {
      throw new Error('No bridge URL. Run tools/web-stratum-bridge locally or set voltminer.web.bridgeWs.');
    }
    this.stop({ silent: true });
    this.wantRun = true;
    this.totalHashes = 0;
    this.windowHashes = 0;
    this.hashrate = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.wasmReady = false;
    this.rpcId = 1;
    this.submitIds.clear();
    this.sessionId = null;
    const rawWallet = wallet.trim();
    // MO start-diff is wallet+N (password d=N is ignored). Floor is 10000.
    this.wallet = /\+\d+$/.test(rawWallet) ? rawWallet : `${rawWallet}+10000`;
    this.password = password || 'x';
    this.threads = Math.max(1, Math.min(hardwareThreads(), threads | 0 || 1));
    this.bridgeUrl = url;
    this.#spawnWorkers(this.threads);
    this.#connect();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send('ping'); } catch { /* ignore */ }
      }
    }, 25000);
    this.statsTimer = setInterval(() => {
      this.hashrate = this.windowHashes / 2;
      this.windowHashes = 0;
      this.#emit('stats', {});
    }, 2000);
    this.#emit('status', { message: 'Connecting to bridge…' });
  }

  setThreads(n) {
    const target = Math.max(1, Math.min(hardwareThreads(), n | 0));
    this.threads = target;
    while (this.workers.length < target) this.#addWorker();
    while (this.workers.length > target) this.#removeWorker();
    this.#broadcastJob();
    this.#emit('stats', {});
  }

  stop({ silent = false } = {}) {
    this.wantRun = false;
    this.connected = false;
    this.job = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.#killWorkers();
    if (!silent) this.#emit('status', { message: 'Stopped.' });
  }

  #nextId() {
    return this.rpcId++;
  }

  #send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
  }

  #connect() {
    if (!this.wantRun) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    let ws;
    try {
      ws = new WebSocket(this.bridgeUrl);
    } catch (err) {
      this.#emit('error', { message: 'WebSocket constructor failed: ' + err.message });
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.loginId = this.#nextId();
      this.#send({
        id: this.loginId,
        jsonrpc: '2.0',
        method: 'login',
        params: {
          login: this.wallet,
          pass: this.password,
          agent: 'VoltMiner-web/rx-experiment',
          algo: ['rx/0', 'rx/wow'],
        },
      });
      this.#emit('status', { message: 'Connected. Logging in…' });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const raw = String(e.data || '');
      if (raw === 'pong') return;
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        this.#onRpc(obj);
      }
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.#emit('error', { message: 'WebSocket error (is the VPS bridge running? ad-blockers also kill this).' });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.job = null;
      this.#emit('status', { message: 'Disconnected from bridge.' });
      this.#scheduleReconnect();
    };
  }

  #onRpc(obj) {
    if (obj.method === 'job' && obj.params) {
      this.#setJob(obj.params);
      return;
    }
    if (obj.id === this.loginId) {
      this.loginId = null;
      if (obj.error) {
        this.#emit('error', { message: 'Login failed: ' + (obj.error.message || JSON.stringify(obj.error)) });
        return;
      }
      const result = obj.result || {};
      this.sessionId = result.id || null;
      if (result.job) this.#setJob(result.job);
      else this.#emit('status', { message: 'Logged in. Waiting for a job…' });
      return;
    }
    if (this.submitIds.has(obj.id)) {
      this.submitIds.delete(obj.id);
      if (obj.error || obj.result === false) {
        this.rejected += 1;
        this.#emit('error', { message: 'Share rejected: ' + (obj.error?.message || 'false') });
      } else {
        this.accepted += 1;
        this.#emit('accepted', {});
      }
    }
  }

  #setJob(job) {
    const algo = job.algo || job.algorithm || 'rx/0';
    this.job = {
      job_id: job.job_id,
      blob: job.blob,
      target: job.target,
      seed_hash: job.seed_hash || job.seedhash || '',
      height: job.height || 0,
      algo,
    };
    this.#broadcastJob();
    this.#emit('job', { jobId: job.job_id, algo });
  }

  #broadcastJob() {
    if (!this.job) return;
    for (const wrk of this.workers) {
      wrk.postMessage({ type: 'job', job: this.job });
    }
  }

  #scheduleReconnect() {
    if (!this.wantRun) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantRun) this.#connect();
    }, 3000);
  }

  #spawnWorkers(n) {
    this.#killWorkers();
    for (let i = 0; i < n; i++) this.#addWorker();
  }

  #addWorker() {
    const wrk = new Worker(new URL('./miner-worker.js', import.meta.url));
    wrk.onmessage = (e) => this.#onWorkerMsg(wrk, e.data);
    this.workers.push(wrk);
    if (this.job) wrk.postMessage({ type: 'job', job: this.job });
  }

  #removeWorker() {
    const wrk = this.workers.pop();
    if (wrk) wrk.terminate();
  }

  #killWorkers() {
    for (const wrk of this.workers) wrk.terminate();
    this.workers = [];
  }

  #onWorkerMsg(_wrk, data) {
    if (!this.wantRun) return;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'debug') {
      this.#emit('status', { message: `hash sample ${String(data.result || '').slice(0, 16)}… target ${data.target} ok=${data.ok}` });
      return;
    }
    if (data.type === 'ready') {
      this.wasmReady = !!data.wasm;
      this.#emit('status', {
        message: data.wasm
          ? 'RandomX Wasm ready.'
          : 'RandomX Wasm missing — hard-refresh (Cmd-Shift-R); the worker could not load web-randomx.js.',
      });
      return;
    }
    if (data.type === 'hashes') {
      this.totalHashes += data.n || 0;
      this.windowHashes += data.n || 0;
      return;
    }
    if (data.type === 'solved') {
      this.totalHashes += 1;
      this.windowHashes += 1;
      const id = this.#nextId();
      this.submitIds.set(id, true);
      this.#send({
        id,
        jsonrpc: '2.0',
        method: 'submit',
        params: {
          id: this.sessionId,
          job_id: data.job_id,
          nonce: data.nonce,
          result: data.result,
        },
      });
    }
  }
}
