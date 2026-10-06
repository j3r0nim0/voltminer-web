# Browser miner — backlog

Thread: **browser miner** (`voltminer-web`, `web.voltminer.net`).
Sibling thread: **Anvil/Android** (`android-xmrig-monero/TODO.md`, performance track).

Split on 2026-10-06 because the two share a source lineage and almost nothing else.
Rule for this file: every item carries the evidence that put it here, so nobody has to
re-derive it. Items are ordered by expected value, not by ease.

---

## A. Hash rate — the big lever

### A1. We run the interpreter. Theirs runs a JIT. This is the gap.

`wasm32` falls into RandomX's fallback branch, so `vm_compiled.cpp` links as a no-op:

```c
// common.hpp
#if defined(_M_X64) || defined(__x86_64__)   → JitCompilerX86,  HAVE_COMPILER 1
#elif defined(__aarch64__)                   → JitCompilerA64,  HAVE_COMPILER 1
#elif defined(__riscv) && __riscv_xlen == 64 → JitCompilerRV64, HAVE_COMPILER 1
#else                                        → JitCompilerFallback, HAVE_COMPILER 0   ← us
```

`randomx.cpp` then does `flags = RANDOMX_HAVE_COMPILER ? RANDOMX_FLAG_JIT : RANDOMX_FLAG_DEFAULT`,
so we never even ask for it. We ship `vm_compiled.cpp` and it is inert.

`aa022/RandomX-bonanza` solved this properly: a **wasm emitter as a JIT backend** — LEB128
encoder, instruction encoder, generator, decoder (`wasm_jit_leb128.c`, `wasm_jit_inst.c`,
`wasm_jit_gen.c`, `wasm_jit_decode.c`, `wasm_jit_compiler.cpp`), plus a static fused path
(`wasm_jit_superscalar.cpp` + a 260 KB `wasm_jit_fuse_table.h`) and a generated threaded
interpreter. Live, not aspirational — exports `_rxjit_stat_dyn_compile_us`,
`_rxjit_set_shared_code`, `_rxjit_stat_module_hash` / `_same` / `_mismatch`.

Their numbers vs ours (not same-machine, but the per-thread ratio is not close):

| | bonanza | us |
|---|---|---|
| full, 1 thread | 175 H/s (25% of native) | — |
| full, 4 threads | 647 H/s | ~110 H/s |
| light, 1 thread | 47 H/s (**66% of native**) | — |
| wasm payload | 398 KB + 51 KB glue | 102 KB + 26 KB |

We are *smaller* because we left the JIT out. Their extra ~220 KB buys 3–6×.

**Licence: CC0, and provenance is now checked (2026-10-06)** — adoptable, no obligations
on their code. Verified by diffing against `l1mey112/randomx.js`, which is *itself* a wasm
RandomX JIT and shares the `wasm_jit_*` / `jit_vm_*` / `jit_ssh` / `stubs` naming, so
derivation was a real possibility:

- `jit_stubs/semifloat.c` and `jit_stubs/mulh.c` are **byte-identical** to l1mey112's
  (`sha256 352257ea…`, `5c5bbf80…`). Those are exactly the two files aa022 credits them for,
  so the credit is accurate rather than understated.
- The JIT proper (`wasm_jit_gen.c`, `_inst.c`, `_decode.c`, `_run.cpp`, `_superscalar.cpp`,
  `_threaded.c`, `_compiler.cpp` — 12,000+ lines) shares **zero comment lines** with
  l1mey112 and has identifier Jaccard 0.05–0.39, with the highest matches on `_leb128` /
  `_macros` (shared wasm-opcode vocabulary, not sharing). Their files are also consistently
  larger. Independent implementation, l1mey112 as design reference.
- Supporting detail: l1mey112 encodes JIT capability as an enum (0/1/2), aa022 as a bitmask
  (`feature=7`). Same idea, different design.

**What that means for attribution:** the JIT is CC0 — nothing owed. The two copied stubs and
the vendored `wasm/src/` RandomX tree are **BSD-3-Clause** (`tevador` + The Monero Project,
and `l-m <l-m@l-m.dev>` for the stubs), so the notice must be retained for those, which
`notices.html` already does for RandomX and needs one line added for l-m.

Corrected earlier claim: I first flagged the CC0 as likely overreaching on the JIT files.
That was wrong — it was based on filename similarity, which is shared vocabulary, not
shared code.

### A2. Measured 2026-10-06 — DONE. It is real, it is correct, and it's worth ~3–5×.

Built theirs with **our own toolchain** (`emscripten/emsdk:4.0.10`, one command,
`ST_BUILD=0`, no patching) and ran their tests on the M3.

**Correctness — the gate.** `node bench/canonical_hash.mjs` passes RandomX's official test
vector:

```
Hash:     8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9
Expected: 8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9
PASS - hash matches canonical RandomX test vector.
```

This is the thing that mattered. A wasm JIT that is fast but wrong is worse than our
interpreter — that is exactly the bug we spent this project on. It is not wrong.

**Speed, paired, same harness, one flag apart (Apple M3, 8 cores, 4 threads, 12 s/pass):**

| | H/s | H/s/thread |
|---|---|---|
| interpreter (`--nojit`) | **60** | 15 |
| JIT (baseline) | **284** | 71 |

≈**4.7×** from the JIT alone. Against our own build (~110 H/s at 4 threads in headless
Chrome on the same machine) their JIT is ~2.6–3.4×. Note the variance: four "identical"
baseline runs gave 284 / 338 / 376 / 381, so quote **3–5×**, not a point value.

Two calibration notes. Their README claims 647 H/s at 4 threads on an M4; we reproduced 376
on an M3 at best, so **their published table runs ~1.7× optimistic**. And their *interpreter*
(60 H/s) is slower than our build (~110 H/s), which is worth understanding before assuming
we'd land at exactly 4.7× — our interpreter is not their interpreter.

**Port shape — much smaller than feared.**

- The seam is **not** RandomX's `JitCompiler`: their `common.hpp` and
  `jit_compiler_fallback.hpp` are stock upstream, and wasm still takes the
  `HAVE_COMPILER 0` branch. They hook the **interpreter** instead — four call sites in
  `vm_interpreted.cpp` (`rxjit_run_program_full` / `_light`). We *already* patch that file.
- The call mechanism is **`EM_JS`**: C hands the generated wasm bytes to a JS trampoline
  (`rxjit_js_run`), which does `new WebAssembly.Instance(new WebAssembly.Module(bytes))`
  against the existing shared memory and calls the program — **once per hash**, not per
  instruction, so the JS boundary is free. Their comment notes EM_JS is used deliberately
  *"so it's available in every pthread"*. `rx_aes_relaxed_hf` is the same pattern for their
  raw-wasm AES side module, so it is a proven template twice over.
- **Size:** JIT core ≈ **4,900 LOC** (`wasm_jit_run.cpp` 1,301, `wasm_jit_compiler.cpp`
  1,007, `wasm_jit_decode.c` 676, `wasm_jit_gen.c` 631, `wasm_jit_inst.c` 601,
  `wasm_jit_superscalar.cpp` 655, `wasm_jit_leb128.c` 37). The ~6,800 lines of threaded
  interpreter + `wasm_jit_fuse_table.h` are **optional**: supjit measured ~4%, i.e. inside
  the noise.
- **CSP: no change needed.** `new WebAssembly.Module(bytes)` is compiling wasm from bytes,
  which `script-src 'self' 'wasm-unsafe-eval'` already permits. That was added for the
  Emscripten glue.
- **Payload cost:** their wasm built to **256 KB** vs our 102 KB (mt) — so ~+154 KB, which
  B1's missing gzip would more than absorb.
- **Licence:** CC0. Verify per-file provenance (the semifloat stubs come from l1mey112's
  `randomx.js`).

**A trap to inherit carefully.** From their own bench driver: *"Sharing a single Module
across multiple rxCreateMiningContext / rxInitDatasetStart cycles leaks Emscripten
pthread-pool state — the final pass at 32 threads ends up at ~230 H/s instead of the ~540
H/s a cold-start run delivers."* Our client re-creates workers on thread change and
reconnect, which happens to sidestep this — but it means we must **not** "optimise" by
reusing one Module across mining contexts once the JIT is in.

**ST (no-SAB) variant measured 2026-10-06.** Built with our toolchain (`randomx_st.wasm`
240 KB + 36 KB glue, vs 256 KB + 50 KB for the pthread build). The JIT works without
SharedArrayBuffer — `RX_BUILD=st node bench/canonical_hash.mjs` PASSES the official vector,
so it is correct by test, not by reading their build script.

```
no-SAB build, 4 threads, Apple M3   JIT on    95 H/s   (24/thread)
                                    JIT off   27 H/s   ( 7/thread)     -> 3.5x
for comparison, pthread build       JIT on   284 H/s   JIT off  60 H/s -> 4.7x
```

**The implication matters more than the multiplier.** The no-SAB build is ~3x slower in
absolute terms than the shared-memory build, and ST+JIT (95) lands almost exactly on our
*current* build (~110 H/s, interpreter, pthreads, 4 threads, headless Chrome). So for
desktop/Android the ST variant buys nothing — the 2.6-3.4x is in the shared-memory build.
Where ST+JIT does pay is exactly where we cannot use shared memory at all: it lifts that
configuration 3.5x, which is the iOS-shaped case.

**Replica mode measured 2026-10-06 — it is not a fallback, it is a first-class path.**
`bench/nosab_bench.mjs` runs N worker_threads on `randomx_st` with `--full K` making K of
them full-dataset replicas. Apple M3, 10s windows after warm-up:

```
no-SAB, 4 workers, 0 replicas (4 light)     129.4 H/s   (32.4/worker)
no-SAB, 4 workers, 2 full + 2 light         220.2 H/s   (55.1/worker)
no-SAB, 8 workers, 2 full + 6 light         262.5 H/s   (32.8/worker)

per worker: full replica 82.9 H/s vs light 26.9 H/s -> 3.08x
cost: ~2.3 GB per replica; cooperative dataset build 14.9 s (4 workers) / 10.8 s (8),
      once per seed -- and Monero's seed changes about every two days
```

Three consequences, in order of importance:

1. **220 H/s at 4 workers is 2x what we ship today (~110) — with no SharedArrayBuffer at
   all.** That is the architectural headline: our fast path currently *requires* COOP/COEP
   and `crossOriginIsolated`; this beats it without either. It also closes ~78% of the gap
   to the pthread+JIT build (284).
2. **Their 2.25x replica weighting is conservative** — measured 3.08x.
3. **More cores is not faster.** 4 -> 8 workers gained only 19% (220 -> 262) and per-worker
   fell 40%, because an M3 is 4 performance + 4 efficiency cores and the replicas also
   contend for memory bandwidth. Their `optimizeArm` ("count half the cores") is right, and
   we should apply the same rule to `defaultThreadCount()`, which currently returns
   `hardwareThreads() >= 4 ? 2 : 1` — far below what this machine can use.

**Open design consequence, not yet solved:** our OPFS dataset cache stores *one* ~2 GB
dataset keyed by seed hash. Replica mode implies one dataset per replica, and their
cooperative build rebuilds rather than restoring. Whether N replicas can restore from a
single cached file without copying 2.3 GB into each worker's heap is unresolved and matters
for startup time. Also: iOS is the platform we pinned to 1 thread precisely because it will
not hold the 2 GB dataset, so replicas are probably desktop/Android-only.

**Decision 2026-10-06: no embed, ever.** Not because their implementation is poor — it
takes the embedder's own wallet, gates on a real user gesture, and is pinned to an immutable
commit with SRI — but because the pattern is abuse-prone by construction: the consent UI
belongs to a third party we cannot audit, and the economics push every embedder toward
minimising the friction of saying yes. It also contradicts what our own page promises
("your device, your wallet"), which only works when we own the page.

**Consequence, and it is a simplification:** the embed was the *only* driver for the no-SAB
path, since a third-party page cannot set COOP/COEP on itself and so can never have
`SharedArrayBuffer`. With no embed there is no reason to pursue replica mode. The port
therefore targets **one variant — pthread + SAB + JIT** — which is also the RAM-light one
(284 H/s on a single ~2.3 GB dataset, versus replicas at 220 H/s on two or more). Light mode
remains the soft, low-RAM default and the iOS fallback.

That also closes the open OPFS question above: one dataset keyed by seed hash is exactly
right when there is one shared dataset, which is now the only configuration we ship.

**Next step:** a true paired measurement — our build in their harness, or both in the
browser — then lift the 4,900-line core and merge the four-call-site seam into our
already-patched `vm_interpreted.cpp`.

### A3. Thread counting on ARM: count performance cores, not cores

On Apple Silicon and modern Android, `navigator.hardwareConcurrency` includes efficiency
cores. Spawning that many workers is *slower* than using half. Bonanza ships this as
`optimizeArm` ("full mode on ARM: count half the cores"). We currently take the naive count.

### A4. The no-SharedArrayBuffer path to full-dataset speed

Bonanza's replica mode: independent workers that each hold their own ~2.3 GB dataset
(`1F+3` = 293 H/s, `2F+2` = 417 H/s, weighting a replica at ~2.25× a light worker). **No
COOP/COEP, no SharedArrayBuffer, no pthreads.** 

Strategically this matters more than the raw number: our entire fast path currently
*requires* cross-origin isolation, and COEP is what makes embeds awkward and is a live
suspect in the iOS standalone question (C3). This would make isolation an optimisation
rather than a precondition.

---

## B. Delivery and hosting

### B1. The wasm ships uncompressed

> **DONE — fixed and deployed, verified live 2026-10-06.** Landed in `dea130c`. The Caddyfile
> `encode` matcher now restates Caddy's default text-type list and adds `application/wasm*`.
> Confirmed on the served file, not in the config:
> `curl -sI -H 'Accept-Encoding: gzip' https://web.voltminer.net/js/vendor/randomx/web-randomx-mt.wasm`
> → `content-encoding: gzip`, `content-type: application/wasm`. Left here for the evidence;
> retire on the next pass through this file.

```
/js/vendor/randomx/web-randomx-mt.wasm   102,182 B   content-type: application/wasm
                                          ↑ no content-encoding
```

HTML/CSS/JS all get gzip (`encode gzip` in `tools/server/Caddyfile`); `application/wasm`
does not. First visit is 136 KB as served, of which 102 KB is that file. Gzip or
precompressed variants roughly halve first load to ~70 KB. Repeat visits are already free —
the service worker serves them from cache.

### B2. `MAX_SESSIONS = 8`, and the ninth user fails silently

> **Client half DONE — fixed and deployed in `dea130c`.** `server.mjs` closes with
> `1013 'bridge at capacity'`, and `js/miner-client.js:353–363` now recognises it:
> *"Relay is full right now — every miner slot is taken. This is on our side…"*, with a
> reconnect policy that deliberately does not pile back onto a full relay. What remains is
> the number itself: whether 8 is the right cap, which is gated on B3 (the pool's per-IP
> limit) and on the load figures in B4 (~61 kB/session, 2 fds).

`Environment=BRIDGE_MAX_SESSIONS=8` in `/etc/systemd/system/voltminer-bridge.service`.
Rejected, not queued.

### B3. Ask MoneroOcean for their per-IP connection limit before raising B2

Every session egresses from one address (`137.184.209.157`), so the pool sees N connections
from one IP. Pools commonly cap that per IP — our own client code already says *"pool IP-bans
fast logins"*, learned the hard way this project. Also a shared-fate risk: one misbehaving
client can get the IP banned for everybody. Scaling out means more egress IPs, not a bigger
VPS.

### B4. VPS headroom (measured 2026-10-06)

1 shared vCPU (`DO-Regular`), 458 MB RAM / 283 MB available, **65 MB already in swap while
idle**, disk 46%. The relay does no hashing — hashing is client-side — so the marginal cost
per session is ~30–60 KB of RSS and ~1–2 KB/min of traffic (~65 MB/month per 24/7 user;
the DO tier includes ~1 TB, so bandwidth is irrelevant). Estimated ceiling **~1,000–3,000
concurrent sessions, RAM-bound and not verified under load**. Message rate at 1,000 sessions
is ~14 msg/s of JSON — nothing. The CPU risk is a TLS handshake storm, not steady state.

The estimate is unverified because a real load test from this IP would trip B3. Needs a
second IP before it can be measured properly.

**Now measured (2026-10-06).** Load test built for this: a TLS **stub pool**, the real
`server.mjs` retargeted at it by replacing only the three upstream constants — so every line
of session logic runs *including the certificate pin*, and MoneroOcean is never dialed. Note
the second-IP idea doesn't actually protect the pool (the *relay* dials it, not the
generator); not dialing it does. Sessions were held and RSS read from `/proc`.

```
sessions   RSS kB   fds    per-session
       0    60408      25   —
      64    66300     153   92 kB
     192    74220     409   71 kB
marginal cost of the 128 added:   61 kB/session
fds: +128 for 64 sessions, +256 for 192 → exactly 2 per session
```

**~61 kB per session steady-state, 2 file descriptors.** So the 1,000–3,000 estimate holds
and the marginal figure supports the top of that range: ~180 MB of headroom ÷ 61 kB ≈
**2,900 concurrent sessions**. Descriptors (limit 524,288) are not a constraint, and
bandwidth (~65 MB/month per 24/7 user) is irrelevant against the ~1 TB allowance.

Caveats on that number, honestly: it is *idle* sessions — logged in, holding, but not yet
forwarding periodic jobs and submits, so real traffic adds some CPU and buffer. And this is
a 1 vCPU box already 65 MB into swap while idle, so the binding constraint in production
remains CPU and the pool's per-IP policy (B3), not memory. The remaining unknown is a
handshake storm, not steady state.

### B5. Let the user "self-hop" — run the bridge on their own machine

*(Numbered last only because B1/B2 are pending retirement and renumbering a shared doc under
a concurrent writer is worse than an out-of-order id. By value it leads this section: it
subsumes B2–B4 for anyone who takes it.)*

The relay is the only part of this chain that has to be somebody's server, and it is the part
we least want to own — B2, B3 and B4 are all consequences of owning it. Nothing stops the
visitor from running it themselves. This is already the Android app's architecture: the APK
dials `gulf.moneroocean.stream:20032` directly (`server.mjs` header comment: *"same as the
Android app"*) and nobody calls that a server.

**Evidence that this is nearly free to ship — the client already has the hooks:**

- `js/miner-client.js:21` — a page served from `localhost`/`127.0.0.1` resolves its socket to
  `ws://127.0.0.1:8787` with no configuration.
- `js/miner-client.js:19` — `?bridgeWs=` overrides the relay for everyone else.
- `tools/web-stratum-bridge/origin.mjs` — the allowlist already accepts `http://localhost` and
  `http://127.0.0.1` alongside the public origins.
- `tools/dev-server.mjs` — already contains the static handler *and* the COOP/COEP headers
  that make `crossOriginIsolated` true. 63 lines, against the bridge's 192.

**The MoneroOcean case is a zero-code-change path.** The upstream is already a fixed,
DNS-named, TLS endpoint with a pinned cert:

```
POOL_HOST = 'gulf.moneroocean.stream'
POOL_PORT = 20032                                    // TLS twin of 10032
POOL_TLS_SHA256 = '239daadd…'
```

So `BRIDGE_ALLOW_INSECURE=1 node server.mjs` on the user's machine is the whole change —
plus serving the site from the same process (B5's only real work). Login (`wallet+10000`),
job handling and the difficulty checks do not move at all. The p2pool / arbitrary-upstream
variant is the one that needs host/port/pin made configurable **and** the wallet field
re-thought (see below); do MoneroOcean first, because it is free.

**Design constraints, each one learned in the reasoning above:**

- **Loopback is `ws://`, not `wss://`.** A *trusted* cert for `127.0.0.1` means installing a
  root CA (mkcert et al.) — a bigger ask than running the program, and on a machine the user
  does not admin, a non-starter. Chrome and Firefox exempt localhost from mixed-content;
  **Safari and iOS do not** and demand real `wss://` even on loopback. So serve the page
  *from the bridge* at `http://127.0.0.1:PORT`: same origin, `connect-src 'self'` intact, no
  CSP exception, no TLS anywhere.
- **Bind `127.0.0.1`, never `BRIDGE_HOST=0.0.0.0`.** Wide binding turns a laptop into an open
  stratum proxy on café wifi. The origin lock is meaningless on loopback and should be kept
  anyway — it is the guard against exactly that misconfiguration.
- **The cert pin becomes a fleet we cannot fix.** `server.mjs` hard-fails on fingerprint
  mismatch, which is right for a relay we operate. Combined with user-installed copies it
  means one MoneroOcean cert rotation breaks every self-hop at once, silently — a WebSocket
  close in a console nobody is reading, with no click-through and no update channel. Needs a
  configurable pin, a warn-and-continue mode, or a signed remotely-updatable pin list. On
  loopback the pin defends the user against themselves, not against an attacker.
- **Distribution is the wall, as always.** `npx` needs Node, Docker needs Docker; a compiled
  single binary needs nothing (Bun `--compile`, or Go). If this ships, ship the binary with a
  checksum in `transparency/`.
- **Progressive enhancement:** probe `ws://127.0.0.1:8787` on load, use it if it answers, fall
  back to the hosted relay if not. That makes the local hop an *upgrade*, not a prerequisite.
  Reliable only when the page is itself on loopback — from `web.voltminer.net` a probe to
  localhost is the mixed-content / Private Network Access grey area.
- **A4 interacts:** once the no-SAB replica path lands, the local server no longer needs to
  send COOP/COEP at all, and a self-hop becomes a plain file server plus one socket.

**What it buys:**

- Removes us from the path: no session cap (B2), no shared egress IP and no shared-fate ban
  (B3), no VPS to size or verify (B4), and probably lower latency than one DigitalOcean region
  for every user on earth. A residential IP is also what a pool expects to see from a miner —
  our relay's datacenter IP is the thing that looks like a proxy farm.
- The strongest claim in the codebase stops being a claim. *"Login is whatever the browser
  sent. We do not swap it."* is a comment in our source; on the user's machine it is a line
  they can read. The local bridge is the only bridge whose honesty is verifiable.

**What it does not buy — do not oversell this:**

- **Not a trustlessness win against the pool.** Same MoneroOcean fee, same custody, same
  `+10000`. Only the *transport* becomes trustless.
- **Privacy is a trade, not a win.** Today the pool sees our IP and the relay sees the user's
  wallet + IP. After this the pool sees the user's IP and their relay sees nothing new.
  Different exposure, not less.
- **No help for C1.** iOS has no Node and no terminal; this is a desktop power-user path.
- **The audience is small by construction.** People willing to run a command largely overlap
  with people who would rather run their own node — or already do — in which case the p2pool
  variant (upstream = their own node, endpoint = `127.0.0.1:3333`-ish, no TLS, no pool at all)
  is the better story, not this one.

**Positioning:** *the relay exists for people who won't install anything.* Everyone else
should be able to cut us out of the path. That is a defensible thing to say out loud.

---

## C. Mobile — tabled, waiting on one artifact

### C1. iOS PWA mining didn't work; Android does

Same wasm, same service worker, same page, same relay, verified working on Android. That
narrows it to WebKit, but there are two very different branches and they look identical from
the outside:

- **never started hashing** — something WebKit-specific (pthread spawn in standalone, wasm
  memory growth, OPFS quota); or
- **started fine, hadn't found a share yet** — iOS is pinned to light mode, and light mode on
  a phone is minutes-to-first-share, not seconds.

Answer is in the hash log / status readout. `diag.html` → **Copy report** on the iPhone
settles it; that report is the one artifact never captured from either device.

Worth knowing before digging: bonanza reports **Safari at ~800 H/s in full mode** versus
Chrome's ~850–880, and works around JavaScriptCore's lack of relaxed SIMD by compiling the
relaxed-SIMD AES into a **separate side module**, embedding the bytes in the wasm as a
header, and instantiating it at runtime ("randomx.wasm itself must stay relaxed-free for
JSC"). So WebKit is not inherently the answer — this can work.

### C2. We are pinned to light mode on iOS for memory reasons

One thread, `defaultThreadCount()` returns 1 on iOS. If C1 turns out to be "slow, not
broken", A1 is the fix: light mode is exactly where the interpreter hurts most.

---

## D. Correctness — same neighbourhood, not optimisation

### D1. Our rounding fix patched a symptom; theirs avoids the cause

Full write-up: `docs/WEB-RANDOMX-MT-ROUNDING-RACE.md` (moved here from the Android
repo on 2026-10-06 — it was untracked there, i.e. one `git clean` from being lost).

We made RandomX's process-global FP-mode globals `__thread` so concurrent VMs can't clobber
each other. Bonanza never depends on the host FP rounding mode: explicit `wasm_softround.h`
+ `jit_stubs/semifloat.{c,h}`, exports `_rxSoftroundAdd/Sub/Mul/Div/Sqrt` and
`_rxGetRoundingModePtr`, credited to l1mey112's semifloat. Worth knowing if that code is
touched again — their design has no shared mutable state to clobber.

### D2. Keep the self-check

`verifySolved()` re-hashes every solved share with the single-VM path and drops it if the
result isn't the hash of the nonce it reported. That is the guard that turns this entire
class of bug from *"every share silently rejected"* into a visible, loud drop. Do not remove
it when touching the worker.

---

## Not this thread

- **Fee stripping / `FeeScheduler` removal** — the Flutter product (`voltminer`), Android thread.
- **GPL-3 propagation** for an APK embedding Anvil/RandomX — Android thread.
- **GAMIFIED headline stuck behind Cloudflare's HTML cache** (`cf-cache-status: HIT`,
  un-purgeable from the CLI) — `voltminer.net` product site, needs dashboard → Purge
  Everything. Same repo as the fee work, not the browser miner.

## Loose ends to resolve

- **The relay now exists twice**: tracked in `voltminer-web/tools/web-stratum-bridge/` and
  untracked in `voltminer/tools/web-stratum-bridge/` (208 K). This is the same
  hand-synced-duplicate hazard as `transparency/wasm-patch` vs `third_party/`. Decide the
  canonical copy (this repo — it is deployed from here) and delete the other.
- **A4 cites a `C3` that does not exist.** A4 says COEP *"is a live suspect in the iOS
  standalone question (C3)"*, but section C contains only C1 and C2. Either C3 was dropped in
  the split or it was never written. Re-point that reference at C1 (which owns the WebKit
  question) or restore the item — as written it sends a reader looking for something that
  isn't there.
