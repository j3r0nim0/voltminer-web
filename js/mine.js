import {
  MinerClient,
  isValidWallet,
  hardwareThreads,
  defaultThreadCount,
  loadOrCreateWorkerId,
} from './miner-client.js';

const $ = (id) => document.getElementById(id);

const walletEl = $('wallet');
const threadsEl = $('threads');
const threadsVal = $('threads-val');
const threadsMax = $('threads-max');
const consentEl = $('consent-ok');
const form = $('mine-form');
const startBtn = $('start');
const stopBtn = $('stop');
const statsBox = $('stats');
const logEl = $('st-log');
const moLink = $('mo-link');

document.documentElement.dataset.minerJs = 'ok';
if ($('js-gate')) $('js-gate').hidden = true;

const maxThreads = hardwareThreads();
const workerId = loadOrCreateWorkerId();

threadsEl.max = String(maxThreads);
threadsEl.value = String(defaultThreadCount());
threadsMax.textContent = `(of ${maxThreads} cores — leave at least one free)`;
threadsVal.textContent = threadsEl.value;
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

function setStatus(msg) {
  $('st-status').textContent = msg;
  logEl.hidden = false;
  logEl.textContent = msg;
  statsBox.hidden = false;
}

function render(stats) {
  statsBox.hidden = false;
  $('st-hs').textContent = `${stats.hashrate.toFixed(1)} H/s`;
  $('st-th').textContent = String(stats.threads);
  $('st-ok').textContent = String(stats.accepted);
  $('st-tot').textContent = String(stats.totalHashes);
}

const client = new MinerClient((ev) => {
  if (ev.stats) render(ev.stats);
  if (ev.type === 'status' || ev.type === 'error') setStatus(ev.message);
  if (ev.type === 'job') setStatus(`Job ${ev.jobId || ''} (${ev.algo || 'rx/0'})`);
  if (ev.type === 'accepted') setStatus(`Share accepted (${ev.stats.accepted})`);
});

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
  if (!consentEl.checked) {
    setStatus('Tick the consent box first.');
    return;
  }
  try { localStorage.setItem('voltminer.web.wallet', wallet); } catch (_) { /* ignore */ }
  moLink.href = `https://moneroocean.stream/#/wallet/${encodeURIComponent(wallet)}/overview`;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  walletEl.disabled = true;
  consentEl.disabled = true;
  setStatus('Starting…');

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
  setStatus('Stopped.');
});

window.addEventListener('pagehide', () => { if (client.wantRun) client.stop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && client.wantRun) {
    setStatus('Tab hidden — hashing may pause until you come back.');
  }
});
