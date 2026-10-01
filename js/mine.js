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
const consentEl = $('consent');
const form = $('mine-form');
const startBtn = $('start');
const stopBtn = $('stop');
const statsBox = $('stats');
const logEl = $('st-log');
const moLink = $('mo-link');

const maxThreads = hardwareThreads();
const workerId = loadOrCreateWorkerId();

threadsEl.max = String(maxThreads);
threadsEl.value = String(defaultThreadCount());
threadsMax.textContent = `(of ${maxThreads} cores — leave at least one free)`;
threadsVal.textContent = threadsEl.value;
$('st-wid').textContent = workerId;
$('st-wid-inline').textContent = workerId;

try {
  const saved = localStorage.getItem('voltminer.web.wallet');
  if (saved && isValidWallet(saved)) walletEl.value = saved;
} catch (_) { /* ignore */ }

threadsEl.addEventListener('input', () => {
  threadsVal.textContent = threadsEl.value;
  if (client.wantRun) client.setThreads(Number(threadsEl.value));
});

function setStatus(msg) {
  $('st-status').textContent = msg;
  logEl.textContent = msg;
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

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const wallet = walletEl.value.trim();
  if (!isValidWallet(wallet)) {
    setStatus('That does not look like a Monero mainnet address.');
    statsBox.hidden = false;
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
  statsBox.hidden = false;
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
  // iOS and desktop browsers freeze workers in background tabs; be honest.
  if (document.hidden && client.wantRun) {
    setStatus('Tab hidden — hashing may pause until you come back.');
  }
});
