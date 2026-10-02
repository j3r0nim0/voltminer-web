import {
  MinerClient,
  isValidWallet,
  defaultThreadCount,
  canShareDataset,
  hardwareThreads,
  loadOrCreateWorkerId,
} from './miner-client.js';

const $ = (id) => document.getElementById(id);

const walletEl = $('wallet');
const threadsEl = $('threads');
const threadsVal = $('threads-val');
const threadsMax = $('threads-max');
const consentEl = document.querySelector('#mine-form input[name="consent"]') || $('consent-ok');
const form = $('mine-form');
const startBtn = $('start');
const stopBtn = $('stop');
const statsBox = $('stats');
const logEl = $('st-log');
const moLink = $('mo-link');
const hashLogEl = $('hash-log');
const hashLogWrap = $('hash-log-wrap');
const hashLogClear = $('hash-log-clear');
const MAX_LOG = 200;
const logLines = [];

document.documentElement.dataset.minerJs = 'ok';
if ($('js-gate')) $('js-gate').hidden = true;

const workerId = loadOrCreateWorkerId();

if (canShareDataset()) {
  const max = Math.max(1, Math.min(8, hardwareThreads()));
  const def = defaultThreadCount();
  threadsEl.max = String(max);
  threadsEl.value = String(def);
  threadsEl.disabled = false;
  threadsMax.textContent = `(${max} C++ threads, one 2 GB dataset — web.voltminer.net)`;
  threadsVal.textContent = String(def);
} else {
  threadsEl.max = '1';
  threadsEl.value = '1';
  threadsEl.disabled = true;
  threadsMax.textContent = '(one Wasm worker — this origin cannot share the dataset)';
  threadsVal.textContent = '1';
}
$('st-wid').textContent = workerId;
$('st-wid-inline').textContent = workerId;

function normalizeWallet(raw) {
  return String(raw || '')
    .trim()
    .replace(/^monero:/i, '')
    .replace(/\s+/g, '');
}

try {
  const saved = localStorage.getItem('voltminer.web.wallet');
  if (saved && isValidWallet(normalizeWallet(saved))) walletEl.value = saved;
} catch (_) { /* ignore */ }

threadsEl.addEventListener('input', () => {
  threadsVal.textContent = threadsEl.value;
  if (client.wantRun) client.setThreads(Number(threadsEl.value));
});

let filling = false;
let lastFillPct = -1;
let soakStartedAt = 0;
let soakTimer = null;

function formatSoak(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function paintSoak() {
  const el = $('st-soak');
  if (!el) return;
  if (!soakStartedAt) {
    el.textContent = '0:00';
    return;
  }
  el.textContent = formatSoak(Date.now() - soakStartedAt);
}

function startSoakClock() {
  soakStartedAt = Date.now();
  if (soakTimer) clearInterval(soakTimer);
  paintSoak();
  soakTimer = setInterval(paintSoak, 1000);
}

function stopSoakClock() {
  if (soakTimer) {
    clearInterval(soakTimer);
    soakTimer = null;
  }
  paintSoak();
}

function setStatus(msg) {
  $('st-status').textContent = msg;
  logEl.hidden = false;
  logEl.textContent = msg;
  statsBox.hidden = false;
}

function setDataset(label) {
  const el = $('st-ds');
  if (el) el.textContent = label;
}

function logLine(kind, msg) {
  if (!hashLogEl) return;
  const t = new Date().toISOString().slice(11, 23);
  logLines.push({ kind, text: `${t}  ${msg}` });
  if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
  hashLogWrap.hidden = false;
  hashLogEl.innerHTML = logLines.map((l) => {
    const cls = l.kind ? ` class="log-${l.kind}"` : '';
    return `<span${cls}>${escapeHtml(l.text)}</span>`;
  }).join('\n');
  hashLogEl.scrollTop = hashLogEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function render(stats) {
  statsBox.hidden = false;
  $('st-hs').textContent = `${stats.hashrate.toFixed(1)} H/s`;
  $('st-th').textContent = String(stats.threads);
  $('st-ok').textContent = String(stats.accepted);
  $('st-tot').textContent = String(stats.totalHashes);
  paintSoak();
}

const client = new MinerClient((ev) => {
  if (ev.stats) render(ev.stats);
  if (ev.type === 'ds') {
    filling = (ev.pct | 0) < 100;
    lastFillPct = ev.pct | 0;
    const line = `Dataset fill ${lastFillPct}%`;
    setDataset(`${lastFillPct}%`);
    setStatus(line);
    logLine('hash', line);
  }
  if (ev.type === 'status') {
    if (/fast\/full dataset ready|restored from disk/i.test(ev.message || '')) {
      filling = false;
      setDataset('100% full');
    }
    if (/light\/cache ready/i.test(ev.message || '')) setDataset('light');
    if (/Dataset alloc failed|fill aborted/i.test(ev.message || '')) {
      filling = false;
      setDataset('light');
    }
    if (/Restoring ~2 GB|Saving dataset|Checking OPFS|Filling in chunks/i.test(ev.message || '')) {
      filling = true;
    }
    if (filling && /^Job /i.test(ev.message || '')) {
      logLine('', ev.message);
    } else {
      setStatus(ev.message);
      logLine('', ev.message);
    }
  }
  if (ev.type === 'error') {
    setStatus(ev.message);
    logLine('err', ev.message);
  }
  if (ev.type === 'job') {
    const line = `job ${ev.jobId || ''} algo=${ev.algo || 'rx/0'} diff=${ev.diff || '?'} height=${ev.height || '?'} target=${ev.target || ''}`;
    logLine('job', line);
    if (!filling) setStatus(`Job ${ev.jobId || ''} (${ev.algo || 'rx/0'}) diff ${ev.diff || '?'}`);
  }
  if (ev.type === 'tick') {
    const dt = ev.dt ? `  ${ev.dt.toFixed(1)}s` : '';
    logLine('hash', `${(ev.hashrate || 0).toFixed(1)} H/s  +${ev.n || 0} hashes  total=${ev.total || 0}  job=${ev.jobId || '—'}${dt}`);
  }
  if (ev.type === 'submit') {
    logLine('job', `submit job=${ev.jobId || ''} nonce=${ev.nonce || ''} result=${String(ev.result || '').slice(0, 16)}… hashDiff=${ev.hashDiff || '?'} jobDiff=${ev.jobDiff || '?'} target=${ev.target || ''} local=${ev.ok ? 'ok' : 'below-target'}`);
  }
  if (ev.type === 'accepted') {
    setStatus(`Share accepted (${ev.stats.accepted})`);
    logLine('ok', `accepted  total=${ev.stats.accepted}`);
  }
});

if (hashLogClear) {
  hashLogClear.addEventListener('click', () => {
    logLines.length = 0;
    hashLogEl.textContent = '';
  });
}

function startMining() {
  const wallet = normalizeWallet(walletEl.value);
  walletEl.value = wallet;
  if (!wallet) {
    setStatus('Paste a Monero mainnet address first (starts with 4 or 8, 95 characters).');
    walletEl.focus();
    return;
  }
  if (!isValidWallet(wallet)) {
    setStatus(`That is not a Monero mainnet address (${wallet.length} chars). Standard is 95, integrated is 106. Never a private key.`);
    return;
  }
  if (!consentEl) {
    setStatus('Consent checkbox missing — hard-refresh (Cmd-Shift-R).');
    return;
  }
  if (!consentEl.checked) {
    consentEl.focus();
    const row = document.getElementById('consent-row');
    if (row) row.style.outline = '3px solid var(--red, #ff5a5a)';
    setStatus('Tick the yellow box under Threads first (the one that says “I agree”).');
    return;
  }
  try { localStorage.setItem('voltminer.web.wallet', wallet); } catch (_) { /* ignore */ }
  moLink.href = `https://moneroocean.stream/#/wallet/${encodeURIComponent(wallet)}/overview`;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  walletEl.disabled = true;
  consentEl.disabled = true;
  startSoakClock();
  setStatus('Starting…');
  logLine('', `start soak=${formatSoak(0)}`);

  try {
    client.start({
      wallet,
      password: workerId,
      threads: Number(threadsEl.value),
      throttle: 0,
    });
  } catch (err) {
    setStatus(err.message || String(err));
    startBtn.disabled = false;
    stopBtn.disabled = true;
    walletEl.disabled = false;
    consentEl.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  startMining();
});
startBtn.addEventListener('click', (e) => {
  e.preventDefault();
  startMining();
});

stopBtn.addEventListener('click', () => {
  client.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  walletEl.disabled = false;
  consentEl.disabled = false;
  stopSoakClock();
  const elapsed = soakStartedAt ? formatSoak(Date.now() - soakStartedAt) : '0:00';
  setStatus(`Stopped. Soak ${elapsed}.`);
  logLine('', `stop soak=${elapsed}`);
});

window.__voltminer = client;
window.addEventListener('pagehide', () => { if (client.wantRun) client.stop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && client.wantRun) {
    setStatus('Tab hidden — hashing may pause until you come back.');
  }
});
