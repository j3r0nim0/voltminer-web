/* VoltMiner device diagnostics (diag v55). One copyable plain-text report for an
   iPhone with no console: open, wait, tap Copy report, paste it back. Does not
   mine and sends nothing anywhere. Classic script: no module, eval or Function. */
(() => {
  'use strict';
  const VERSION = 'diag v59';
  const WASM_DIR = 'js/vendor/randomx/';
  const EXPECTED = '30aed56ecfba3f935eb906a633c3c412bb5361175bb3dda93070f08615c45c6f';
  // Minimal wasm () -> i32 whose body uses v128; node v22 WebAssembly.validate === true.
  const SIMD_BYTES = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 10, 25, 1, 23, 0,
    253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 65, 0, 11];
  const base = location.href;
  const reportEl = document.getElementById('report');
  const runBtn = document.getElementById('run');
  const copyBtn = document.getElementById('copy');
  const hashStatus = document.getElementById('hash-status');
  const copyStatus = document.getElementById('copy-status');
  const SECTIONS = ['environment', 'display mode', 'isolation and threads', 'service worker',
    'storage', 'wasm reference vector', 'threads build', 'verdict'];
  const body = Object.create(null);
  SECTIONS.forEach((s) => { body[s] = []; });
  const header = VERSION + ' — ' + new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const mb = (n) => (Number(n) / 1048576).toFixed(2) + ' MB';
  const bool = (v) => (v ? 'true' : 'false');
  const msg = (e) => String(e && e.message ? e.message : e);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const push = (s, l) => { body[s].push(l); render(); };
  const kvs = (s, p) => { for (const k in p) push(s, k + ': ' + p[k]); };

  function render() {
    const out = [header];
    for (const s of SECTIONS) if (body[s].length) { out.push('## ' + s); out.push(body[s].join('\n')); }
    reportEl.textContent = out.join('\n\n');
  }
  let isInstalled = false;
  function buildStatic() {
    try {
      const m = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
      kvs('environment', {
        userAgent: navigator.userAgent,
        platform: navigator.platform || '(empty)',
        maxTouchPoints: navigator.maxTouchPoints === undefined ? 'undefined' : navigator.maxTouchPoints,
        hardwareConcurrency: navigator.hardwareConcurrency === undefined ? 'undefined' : navigator.hardwareConcurrency,
        deviceMemory: 'deviceMemory' in navigator ? navigator.deviceMemory + ' GB' : 'undefined (not exposed by this browser)',
        'screen.width x screen.height': screen.width + ' x ' + screen.height,
        devicePixelRatio: window.devicePixelRatio,
        'innerWidth x innerHeight': window.innerWidth + ' x ' + window.innerHeight,
        'location.href': location.href,
        'iOS version (parsed from UA)': m ? m[1] + '.' + m[2] : 'not iOS / not parseable',
      });
    } catch (e) { push('environment', 'error: ' + msg(e)); }
    try {
      const standalone = window.matchMedia('(display-mode: standalone)').matches;
      const fullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
      const ios = ('standalone' in navigator) ? navigator.standalone : undefined;
      isInstalled = !!(standalone || fullscreen || ios === true);
      kvs('display mode', {
        'matchMedia display-mode: standalone': bool(standalone),
        'matchMedia display-mode: fullscreen': bool(fullscreen),
        'navigator.standalone': ios === undefined ? 'undefined (not iOS)' : bool(ios),
        verdict: isInstalled ? 'installed as app' : 'running in a browser tab',
        'html class contains is-standalone': bool(String(document.documentElement.className).includes('is-standalone')),
      });
    } catch (e) { push('display mode', 'error: ' + msg(e)); }
    try {
      let simd;
      try { simd = bool(WebAssembly.validate(new Uint8Array(SIMD_BYTES))); } catch (e) { simd = 'error: ' + msg(e); }
      kvs('isolation and threads', {
        'window.isSecureContext': bool(window.isSecureContext),
        'typeof SharedArrayBuffer': typeof SharedArrayBuffer,
        'globalThis.crossOriginIsolated': bool(globalThis.crossOriginIsolated),
        'typeof Atomics.wait': typeof Atomics.wait,
        'SIMD (WebAssembly.validate of a v128 module)': simd,
      });
    } catch (e) { push('isolation and threads', 'error: ' + msg(e)); }
  }

  async function buildServiceWorker() {
    try {
      push('service worker', "'serviceWorker' in navigator: " + bool('serviceWorker' in navigator));
      push('service worker', 'controller: ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'yes' : 'no'));
      push('service worker', 'window.voltPWA: ' + JSON.stringify(window.voltPWA || null));
      if ('serviceWorker' in navigator) {
        try {
          // js/pwa.js registers on window load and this runs before it, so wait
          // for the registration to settle — otherwise the report says "0
          // registrations" purely because of timing, which reads as a fault.
          await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((r) => setTimeout(r, 6000)),
          ]);
          // give the install handler a moment to finish precaching the shell
          await new Promise((r) => setTimeout(r, 800));
        } catch (e) { /* fall through and report whatever is there */ }
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          push('service worker', 'registrations: ' + regs.length);
          regs.forEach((r, i) => push('service worker', '  #' + i + ' scope: ' + r.scope +
            ', active: ' + (r.active ? r.active.state : 'none') +
            ', waiting: ' + (r.waiting ? r.waiting.state : 'none') +
            ', installing: ' + (r.installing ? r.installing.state : 'none')));
        } catch (e) { push('service worker', 'getRegistrations failed: ' + msg(e)); }
      }
      if (!(window.caches && caches.keys)) { push('service worker', 'caches API: not available'); return; }
      try {
        const names = await caches.keys();
        push('service worker', 'cache names: ' + names.length);
        for (const n of names) {
          try { push('service worker', '  cache ' + n + ': ' + (await (await caches.open(n)).keys()).length + ' entries'); }
          catch (e) { push('service worker', '  cache ' + n + ': error — ' + msg(e)); }
        }
      } catch (e) { push('service worker', 'caches.keys failed: ' + msg(e)); }
    } catch (e) { push('service worker', 'error: ' + msg(e)); }
  }
  async function buildStorage() {
    try {
      const st = navigator.storage;
      if (st && st.estimate) {
        try { const e = await st.estimate(); push('storage', 'estimate used: ' + mb(e.usage)); push('storage', 'estimate quota: ' + mb(e.quota)); }
        catch (e) { push('storage', 'estimate failed: ' + msg(e)); }
      } else push('storage', 'navigator.storage.estimate: not available');
      if (st && st.persisted) {
        try { push('storage', 'persisted: ' + bool(await st.persisted())); }
        catch (e) { push('storage', 'persisted failed: ' + msg(e)); }
      } else push('storage', 'navigator.storage.persisted: not available');
      const hasOpfs = !!(st && st.getDirectory);
      push('storage', 'navigator.storage.getDirectory (OPFS) exists: ' + bool(hasOpfs));
      if (!hasOpfs) return;
      let root;
      try { root = await st.getDirectory(); push('storage', 'OPFS getDirectory() resolves: yes'); }
      catch (e) { push('storage', 'OPFS getDirectory() failed: ' + msg(e)); return; }
      try {
        const items = [];
        for await (const entry of (await root.getDirectoryHandle('voltminer-rx')).values()) {
          items.push(entry.kind === 'file' ? entry.name + ' (' + mb((await entry.getFile()).size) + ')' : entry.name + '/');
        }
        push('storage', 'voltminer-rx contents: ' + (items.length ? items.join(', ') : '(empty)'));
      } catch (e) { push('storage', 'voltminer-rx: cannot open — ' + msg(e)); }
    } catch (e) { push('storage', 'error: ' + msg(e)); }
  }
  const moduleCache = Object.create(null);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  /* Load a build's glue, capture its factory before the next load, then
     instantiate. Cached so a second button press re-uses the module instead of
     allocating another GB of wasm memory on the phone. */
  async function getModule(url) {
    if (moduleCache[url]) return moduleCache[url];
    window.createWebRandomX = undefined;
    await loadScript(url);
    const factory = window.createWebRandomX || window.Module || null;
    window.createWebRandomX = undefined;
    if (typeof factory !== 'function') throw new Error('the glue did not export a factory');
    const module = await factory({
      locateFile: (p) => new URL(WASM_DIR + p.split('/').pop() + '?v=59', base).href,
      mainScriptUrlOrBlob: url,
    });
    if (!module || typeof module._randomx_hash !== 'function') throw new Error('_randomx_hash was not exported');
    moduleCache[url] = module;
    return module;
  }
  /* Same calling convention as js/miner-worker.js: _randomx_hash(0n, 0n,
     seedPtr, blobPtr, len, hashPtr), light/cache mode against a fresh cache. */
  async function hashModule(module) {
    const seedPtr = module._malloc(32);
    const blobPtr = module._malloc(256);
    const hashPtr = module._malloc(32);
    new Uint8Array(module.HEAPU8.buffer, seedPtr, 32).fill(0);
    const blob = new Uint8Array(module.HEAPU8.buffer, blobPtr, 76);
    blob.fill(0);
    blob[39] = 1; // nonce 01000000 little-endian at byte 39
    const t0 = performance.now();
    const ok = module._randomx_hash(0n, 0n, seedPtr, blobPtr, 76, hashPtr);
    const ms = Math.round(performance.now() - t0);
    const out = hex(new Uint8Array(module.HEAPU8.buffer, hashPtr, 32));
    try { module._free(seedPtr); module._free(blobPtr); module._free(hashPtr); } catch (e) { /* ignore */ }
    if (!ok) throw new Error('_randomx_hash returned 0');
    return { hex: out, ms: ms };
  }
  async function probe(url, section, buildLabel, mismatchText, failPrefix) {
    push(section, 'build: ' + buildLabel);
    push(section, 'hashing…');
    try {
      const r = await hashModule(await getModule(url));
      body[section].pop();
      push(section, 'hash: ' + r.hex);
      push(section, 'ms: ' + r.ms);
      if (r.hex === EXPECTED) { push(section, 'RESULT: MATCH'); return true; }
      push(section, 'RESULT: ' + mismatchText);
      push(section, 'expected: ' + EXPECTED);
      return false;
    } catch (e) {
      if (body[section][body[section].length - 1] === 'hashing…') body[section].pop();
      push(section, failPrefix + msg(e));
      return null;
    }
  }
  let running = false;

  async function runHashTest() {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    hashStatus.textContent = 'hashing…';
    const singleUrl = new URL(WASM_DIR + 'web-randomx.js?v=59', base).href;
    const mtUrl = new URL(WASM_DIR + 'web-randomx-mt.js?v=59', base).href;
    body['wasm reference vector'] = []; body['threads build'] = []; body['verdict'] = [];
    push('wasm reference vector', 'seed: 32 bytes of 0x00');
    push('wasm reference vector', 'blob: 76 bytes of 0x00, nonce 01000000 at byte 39');
    push('wasm reference vector', 'expected hash: ' + EXPECTED);
    const single = await probe(singleUrl, 'wasm reference vector', 'single-thread (web-randomx.js)',
      'MISMATCH — do not mine, the wasm is broken on this device', 'single-thread failed — ');
    const isolated = !!(globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    let mt = null;
    if (!isolated) push('threads build', 'skipped: not crossOriginIsolated');
    else mt = await probe(mtUrl, 'threads build', 'pthreads (web-randomx-mt.js)', 'MISMATCH', 'mt build: failed to load — ');
    try {
      push('verdict', 'installed as app: ' + bool(isInstalled));
      push('verdict', 'cross-origin isolated: ' + bool(globalThis.crossOriginIsolated));
      push('verdict', 'single-thread wasm: ' + (single === true ? 'ran, MATCH' : single === false ? 'ran, MISMATCH' : 'did not run'));
      push('verdict', 'pthreads wasm: ' + (!isolated ? 'skipped (not crossOriginIsolated)' : mt === true ? 'ran, MATCH' : mt === false ? 'ran, MISMATCH' : 'did not run'));
      const summary =
        single === true && mt === true ? 'isolated + mt matches + single-thread matches: this device can mine.'
          : single === true && !isolated ? 'single-thread matches but the origin is not isolated: this device can only mine in the slow single-thread mode.'
            : single === true && mt === false ? 'single-thread matches but the pthreads build MISMATCHES: do not use the fast mode on this device.'
              : (single === false || mt === false) ? 'the wasm produced a wrong hash: do not mine on this device until this is fixed.'
                : (single === true && isolated) ? 'single-thread matches but the pthreads build did not run: mine only in single-thread mode.'
                  : 'the hash test did not complete: do not mine on this device until this is fixed.';
      push('verdict', summary);
    } catch (e) { push('verdict', 'error: ' + msg(e)); }
    hashStatus.textContent = '';
    runBtn.disabled = false;
    running = false;
  }
  // copy report: clipboard API, else select the pre; never silently do nothing
  let copyTimer = 0;
  function flashCopy(text) {
    copyStatus.textContent = text;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyStatus.textContent = ''; }, 4000);
  }
  copyBtn.addEventListener('click', () => {
    const text = reportEl.textContent || '';
    const fallback = () => {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(reportEl);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* selecting is best-effort */ }
      flashCopy('Select the text above and copy it manually');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopy('Copied'), fallback);
    } else fallback();
  });
  runBtn.addEventListener('click', () => { runHashTest(); });
  buildStatic();
  (async () => { await buildServiceWorker(); await buildStorage(); })();
  setTimeout(() => { runHashTest(); }, 1500);
})();
