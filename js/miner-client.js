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

export function canShareDataset() {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
}

export function defaultThreadCount() {
  if (!canShareDataset()) return 1;
  const n = hardwareThreads();
  return Math.max(1, Math.min(4, Math.floor(n / 2) || 1));
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
    this.statsAt = 0;
    this.wasmReady = false;
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.lastWorkerAt = 0;
    this.reconnectAttempt = 0;
    this.paused = false;
  }

  #emit(type, detail) {
    this.onEvent({ type, ...detail, stats: this.snapshot() });
  }

  snapshot() {
    return {
      connected: this.connected,
      running: this.wantRun,
      threads: this.threads,
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
    this.statsAt = Date.now();
    this.accepted = 0;
    this.rejected = 0;
    this.wasmReady = false;
    this.rpcId = 1;
    this.submitIds.clear();
    this.sessionId = null;
    this.reconnectAttempt = 0;
    this.paused = false;
    const rawWallet = wallet.trim();
    // Same VarDiff suffix as the APK (MiningService.START_DIFFICULTY = 30000).
    // MO honors wallet+N. 10k was spraying shares at the droplet IP.
    this.wallet = /\+\d+$/.test(rawWallet) ? rawWallet : `${rawWallet}+30000`;
    this.password = password || 'x';
    this.threads = canShareDataset()
      ? Math.max(1, Math.min(4, Number(threads) || 1))
      : 1;
    this.bridgeUrl = url;
    this.lastWorkerAt = Date.now();
    this.#spawnWorkers(1);
    this.#connect();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.wantRun) return;
      const silent = Date.now() - this.lastWorkerAt;
      if (silent > 20000 && this.job) {
        this.#emit('status', {
          message: `Hash worker silent ${Math.round(silent / 1000)}s — dataset still building, or the tab ran out of RAM (need 16 GB).`,
        });
      }
    }, 15000);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send('ping'); } catch { /* ignore */ }
        if (this.sessionId) {
          this.#send({ id: this.#nextId(), jsonrpc: '2.0', method: 'keepalived', params: { id: this.sessionId } });
        }
      }
    }, 10000);
    this.statsAt = Date.now();
    this.statsTimer = setInterval(() => {
      const now = Date.now();
      const dt = Math.max(0.001, (now - this.statsAt) / 1000);
      this.statsAt = now;
      const n = this.windowHashes;
      this.windowHashes = 0;
      this.hashrate = n / dt;
      this.#emit('stats', {});
      if (this.wantRun && n > 0) {
        this.#emit('tick', {
          n,
          hashrate: this.hashrate,
          total: this.totalHashes,
          jobId: this.job?.job_id || '',
          dt,
        });
      }
    }, 2000);
    this.#emit('status', { message: 'Connecting to bridge…' });
  }

  setThreads(n) {
    this.threads = canShareDataset() ? Math.max(1, Math.min(4, Number(n) || 1)) : 1;
    for (const wrk of this.workers) {
      try { wrk.postMessage({ type: 'threads', n: this.threads }); } catch { /* ignore */ }
    }
    this.#emit('stats', {});
  }

  stop({ silent = false } = {}) {
    this.wantRun = false;
    this.connected = false;
    this.job = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.#pauseWorkers();
    if (!silent) this.#emit('status', { message: 'Stopped. Dataset kept in this tab — Start again to skip the 6 min fill.' });
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
      this.reconnectAttempt = 0;
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
      this.#emit('error', { message: 'WebSocket error (tab OOM, ad-blocker, or proxy idle). Close code follows.' });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.job = null;
      this.#pauseWorkers();
      const why = `Disconnected from bridge. code=${ev.code} clean=${ev.wasClean}${ev.reason ? ` reason=${ev.reason}` : ''}. Hashing paused (dataset kept).`;
      this.#emit('status', { message: why });
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
        const em = obj.error.message || JSON.stringify(obj.error);
        this.#emit('error', { message: 'Login failed: ' + em });
        if (/suspended/i.test(em)) {
          this.#pauseWorkers();
          this.#scheduleReconnect(10 * 60 * 1000);
        }
        return;
      }
      const result = obj.result || {};
      this.sessionId = result.id || null;
      if (result.job) this.#setJob(result.job);
      else this.#emit('status', { message: 'Logged in. Waiting for a job…' });
      return;
    }
    if (this.submitIds.has(obj.id)) {
      const kind = this.submitIds.get(obj.id);
      this.submitIds.delete(obj.id);
      const msg = obj.error?.message || (obj.result === false ? 'false' : JSON.stringify(obj.result));
      if (obj.error || obj.result === false) {
        if (kind !== 'probe') this.rejected += 1;
        this.#emit('error', { message: (kind === 'probe' ? 'Probe: ' : 'Share rejected: ') + msg });
        if (/low difficulty/i.test(msg || '')) {
          this.#emit('status', { message: 'Low difficulty — valid RandomX, below this job’s target. Keep hashing; do not reconnect.' });
        }
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
    this.#resumeWorkers();
    this.#broadcastJob();
    this.#emit('job', { jobId: job.job_id, algo });
  }

  #broadcastJob() {
    if (!this.job) return;
    for (const wrk of this.workers) {
      wrk.postMessage({ type: 'job', job: this.job });
    }
  }

  #pauseWorkers() {
    this.paused = true;
    for (const wrk of this.workers) {
      try { wrk.postMessage({ type: 'pause' }); } catch { /* ignore */ }
    }
  }

  #resumeWorkers() {
    this.paused = false;
    for (const wrk of this.workers) {
      try { wrk.postMessage({ type: 'resume' }); } catch { /* ignore */ }
    }
  }

  #scheduleReconnect(ms) {
    if (!this.wantRun) return;
    if (this.reconnectTimer) return;
    if (ms == null) {
      this.reconnectAttempt += 1;
      const exp = Math.min(8, this.reconnectAttempt);
      ms = Math.min(10 * 60 * 1000, 15000 * (2 ** (exp - 1)));
    } else {
      this.reconnectAttempt = 0;
    }
    const wait = Math.max(15000, ms);
    this.#emit('status', { message: `Reconnect in ${Math.round(wait / 1000)}s (pool IP-bans fast logins). Dataset kept.` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantRun) this.#connect();
    }, wait);
  }

  #spawnWorkers(n) {
    if (this.workers.length >= 1) {
      this.#resumeWorkers();
      return;
    }
    this.#killWorkers();
    for (let i = 0; i < n; i++) this.#addWorker();
  }

  #addWorker() {
    const wrk = new Worker(new URL('./miner-worker.js?v=26', import.meta.url));
    wrk.onmessage = (e) => this.#onWorkerMsg(wrk, e.data);
    wrk.onerror = (ev) => {
      const msg = String(ev.message || ev.error || '');
      if (/unwind|ErrorEvent|Uncaught\s+\d+/i.test(msg) || /^\d+$/.test(msg.trim())) {
        try { ev.preventDefault(); } catch { /* ignore */ }
        return;
      }
      this.#emit('error', {
        message: `Hash worker error: ${msg || 'unknown'}`,
      });
    };
    wrk.onmessageerror = () => {
      this.#emit('error', { message: 'Hash worker message error.' });
    };
    this.workers.push(wrk);
    try { wrk.postMessage({ type: 'threads', n: this.threads }); } catch { /* ignore */ }
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
    this.lastWorkerAt = Date.now();
    if (data.type === 'debug') {
      this.#emit('status', { message: `hash sample ${String(data.result || '').slice(0, 16)}… target ${data.target} ok=${data.ok} full=${data.full}` });
      return;
    }
    if (data.type === 'status' && data.message) {
      this.#emit('status', { message: data.message });
      return;
    }
    if (data.type === 'ds') {
      this.#emit('ds', { pct: data.pct });
      return;
    }
    if (data.type === 'dataset') {
      this.#emit('status', {
        message: data.full
          ? 'RandomX fast/full dataset ready. Hashing with full mem.'
          : `RandomX light/cache ready (${(data.ms / 1000).toFixed(1)}s). Will try chunked 2 GB dataset next.`,
      });
      return;
    }
    if (data.type === 'ready') {
      this.wasmReady = !!data.wasm;
      this.#emit('status', {
        message: data.wasm
          ? 'RandomX Wasm loaded. Building dataset next…'
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
      if (!this.connected || !this.sessionId || !this.job) {
        this.#emit('status', { message: `Found share for ${data.job_id} but socket is down — not submitting.` });
        return;
      }
      if (this.job.job_id !== data.job_id) {
        this.#emit('status', { message: `Stale share job=${data.job_id} current=${this.job.job_id} — dropped.` });
        return;
      }
      const id = this.#nextId();
      this.submitIds.set(id, true);
      this.#emit('submit', {
        jobId: data.job_id,
        nonce: data.nonce,
        result: data.result,
      });
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
