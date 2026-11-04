import {
  MinerClient,
  isValidWallet,
  defaultBridgeUrl,
  defaultThreadPercent,
  threadsForPercent,
  canShareDataset,
  hardwareThreads,
  loadOrCreateWorkerId,
} from './miner-client.js?v=80';

const $ = (id) => document.getElementById(id);

const walletEl = $('wallet');
const threadsEl = $('threads');
const threadsVal = $('threads-val');
const threadsMax = $('threads-max');
const fullDatasetEl = $('full-dataset');
const consentEl = document.querySelector('#mine-form input[name="consent"]') || $('consent-ok');
const form = $('mine-form');
const startBtn = $('start');
const stopBtn = $('stop');
const bridgeEl = $('bridge-url');
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

/* The slider is a percent of cores (index.html: min=25 max=100 step=25). The
   label spells out the effective C++ thread count so "50%" is not a mystery. */
function updateThreadsLabel(percent) {
  const pct = Number(percent) || defaultThreadPercent();
  threadsVal.textContent = `${pct}%`;
  threadsMax.textContent = canShareDataset()
    ? `(${threadsForPercent(pct)} of ${hardwareThreads()} C++ threads — shared dataset only with Fast mode)`
    : '(one Wasm worker — this origin cannot share the dataset)';
}

const defPct = defaultThreadPercent();
threadsEl.value = String(defPct);
threadsEl.disabled = !canShareDataset();
updateThreadsLabel(defPct);
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
  const pct = Number(threadsEl.value);
  updateThreadsLabel(pct);
  if (client.wantRun) client.setThreads(threadsForPercent(pct));
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
    const win = ev.window ? `  ${ev.window.toFixed(1)}s avg` : (ev.dt ? `  ${ev.dt.toFixed(1)}s` : '');
    logLine('hash', `${(ev.hashrate || 0).toFixed(1)} H/s  +${ev.n || 0} hashes  total=${ev.total || 0}  job=${ev.jobId || '—'}${win}`);
  }
  if (ev.type === 'submit') {
    logLine('job', `submit job=${ev.jobId || ''} nonce=${ev.nonce || ''} result=${ev.result || ''} hashDiff=${ev.hashDiff || '?'} jobDiff=${ev.jobDiff || '?'} target=${ev.target || ''} local=${ev.ok ? 'ok' : 'below-target'} nlen=${ev.resultLen || '?'} blob39=${ev.blobNonce || ''} rev=${ev.resultRev ? '1' : '0'}`);
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

/** The only place that reflects "is it mining?" in the controls. Stop turns red
    while hashing, so the kill switch is unmissable; Start dims out. */
function setRunningUI(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  walletEl.disabled = running;
  if (bridgeEl) bridgeEl.disabled = running;
  consentEl.disabled = running;
  // The dataset is a start-time decision (~6 min fill, ~2.5 GB), so the opt-in is not
  // live-switchable: disable it while running rather than let it look togglable.
  if (fullDatasetEl) fullDatasetEl.disabled = running;
  stopBtn.classList.toggle('danger', running);
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
  if (chargingOnly && chargingOnly.checked && batteryState && !batteryState.charging) {
    setStatus('This device is on battery. Plug in, or uncheck “Only while charging” to mine anyway.');
    return;
  }
  const bridgeUrl = (bridgeEl && bridgeEl.value.trim()) || defaultBridgeUrl();
  try {
    localStorage.setItem('voltminer.web.wallet', wallet);
    if (bridgeEl && bridgeEl.value.trim()) localStorage.setItem('voltminer.web.bridge', bridgeUrl);
  } catch (_) { /* ignore */ }
  if (bridgeEl) bridgeEl.value = bridgeUrl;
  moLink.href = `https://moneroocean.stream/#/wallet/${encodeURIComponent(wallet)}/overview`;

  // The relay in use, and the one-click check on the pool's own dashboard.
  trRelay.textContent = bridgeUrl;
  if (trRelayPre) trRelayPre.textContent = bridgeUrl;
  trMo.href = moLink.href;

  setRunningUI(true);
  startSoakClock();
  armCap();
  setStatus('Starting…');
  logLine('', `start soak=${formatSoak(0)}`);

  try {
    client.start({
      wallet,
      password: workerId,
      threads: threadsForPercent(Number(threadsEl.value)),
      throttle: 0,
      bridgeUrl,
      // ~2.5 GB fast dataset is opt-in; light/cache is the default.
      fullDataset: !!(fullDatasetEl && fullDatasetEl.checked),
    });
  } catch (err) {
    setStatus(err.message || String(err));
    setRunningUI(false);
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
  setRunningUI(false);
  stopSoakClock();
  clearCap();
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


/* ---------------------------------------------------------------------------
   Transparency affordances. Everything here is visible to the visitor: what is
   stored and how to delete it, whether the device is charging, and a session
   that ends by itself instead of running forever.
   --------------------------------------------------------------------------- */
const OPFS_HINT = 'the RandomX dataset cache (one file per network seed)';
const SESSION_CAP_MS = 60 * 60 * 1000;

const chargingOnly = document.getElementById('charging-only');
const cap60 = document.getElementById('cap60');
const trRelay = document.getElementById('tr-relay');
const trMo = document.getElementById('tr-mo');
let batteryState = null;
let capTimer = null;

async function refreshStorage() {
  const el = document.getElementById('tr-storage');
  if (!el) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
      el.textContent = `${mb(usage)} used${quota ? ` of ${mb(quota)} allowed` : ''} — ${OPFS_HINT}`;
      return;
    }
  } catch (_) { /* ignore */ }
  el.textContent = `not measurable here — ${OPFS_HINT}`;
}

async function deleteCachedData() {
  let removed = 0;
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true });
        removed += 1;
      }
    }
    if (window.caches && caches.keys) {
      for (const k of await caches.keys()) await caches.delete(k);
    }
  } catch (_) { /* ignore */ }
  logLine('', `deleted cached data (${removed} entr${removed === 1 ? 'y' : 'ies'}) — the next Start rebuilds the dataset.`);
  setStatus('Cached dataset deleted.');
  refreshStorage();
}

function forgetWallet() {
  try {
    localStorage.removeItem('voltminer.web.wallet');
    localStorage.removeItem('voltminer.web.bridge');
  } catch (_) { /* ignore */ }
  walletEl.value = '';
  if (bridgeEl) bridgeEl.value = defaultBridgeUrl();
  if (trRelayPre) trRelayPre.textContent = defaultBridgeUrl();
  setStatus('Saved wallet and bridge settings forgotten.');
}

function armCap() {
  clearCap();
  if (!cap60 || !cap60.checked) return;
  capTimer = setTimeout(() => {
    if (!client.wantRun) return;
    client.stop();
    setRunningUI(false);
    stopSoakClock();
    setStatus('60-minute session finished. Nothing is running now — press Start again if you want another hour.');
    logLine('', 'session cap reached (60 min) — stopped.');
  }, SESSION_CAP_MS);
}
function clearCap() {
  if (capTimer) clearTimeout(capTimer);
  capTimer = null;
}

async function initBattery() {
  try {
    if (!navigator.getBattery) return;
    batteryState = await navigator.getBattery();
    const apply = () => {
      if (client.wantRun && chargingOnly && chargingOnly.checked && !batteryState.charging) {
        client.stop();
        setRunningUI(false);
        stopSoakClock();
        clearCap();
        setStatus('Paused — this device is on battery. Plug in to continue, or uncheck “Only while charging”.');
        logLine('', 'paused: on battery');
      }
    };
    batteryState.addEventListener('chargingchange', apply);
    apply();
  } catch (_) { /* ignore */ }
}

const delBtn = document.getElementById('delete-dataset');
if (delBtn) {
  delBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (client.wantRun) {
      setStatus('Stop mining first, then delete the cache.');
      return;
    }
    delBtn.disabled = true;
    await deleteCachedData();
    setTimeout(() => { delBtn.disabled = false; }, 800);
  });
}
const forgetBtn = document.getElementById('forget-wallet');
if (forgetBtn) forgetBtn.addEventListener('click', (e) => { e.preventDefault(); forgetWallet(); });
refreshStorage();
initBattery();
const initialBridge = defaultBridgeUrl();
if (bridgeEl) {
  bridgeEl.value = initialBridge;
  bridgeEl.addEventListener('input', () => {
    const val = bridgeEl.value.trim();
    const effective = val || defaultBridgeUrl();
    if (trRelayPre) trRelayPre.textContent = effective;
    if (trRelay) trRelay.textContent = effective;
    try {
      if (val) localStorage.setItem('voltminer.web.bridge', val);
      else localStorage.removeItem('voltminer.web.bridge');
    } catch (_) {}
  });
}
if (trRelay) trRelay.textContent = initialBridge;
if (trRelayPre) trRelayPre.textContent = initialBridge;
const wasmAuditEl = document.getElementById('wasm-audit-curl');
if (wasmAuditEl && typeof location !== 'undefined') {
  try {
    const wasmUrl = new URL('js/vendor/randomx/web-randomx-mt.wasm', location.href).href;
    wasmAuditEl.textContent = `curl -s ${wasmUrl} | shasum -a 256`;
  } catch (_) {}
}
