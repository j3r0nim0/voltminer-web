# Browser RandomX miner: every tab share was rejected (root cause + fix)

Status: **fixed 2026-10-02.** The Wasm pthread mine path was hashing with the wrong
floating-point rounding mode. It returned a `result` that was not the hash of the
`nonce` it reported, so gulf rebuilt the blob, hashed our nonce, got an unrelated
256-bit value and answered the generic `Low difficulty share`.

Affected: `web-randomx-mt.wasm` (`?v=50`), i.e. every build shipped so far.
Not affected: the Android app (XMRig has a real per-thread FENV).

## Evidence

`/tmp/WebRandomX` (overlay on WebCryptomining/WebRandomX `780908a`) rebuilt, then run
in headless Chrome, in a Worker, exactly like the app (`crossOriginIsolated`,
pthread build, one live gulf job):

```
blob 1010d083…7453   seed 42716401…dca1   height 3775316   target b88d0600 (diff 10000)

before the fix
T1 th=1 max=1    nonce=01000000  mine=49e4bc7a…76db  hash(nonce)=49e4bc7a…76db  MATCH YES
T2 th=2 max=64   nonce=01000000  mine=0f57199e…e64d  hash(nonce)=49e4bc7a…76db  MATCH NO
T3 th=4 max=128  nonce=44332211  mine=26c027fd…e49b  hash(nonce)=1324e537…c93a  MATCH NO
T5 th=2 max=100  nonce=efbeadde  mine=48c44c66…3ecf  hash(nonce)=b5cfd4b1…226e  MATCH NO
```

`max_hashes < 2 * threads` fell back to the single-VM path and was always correct,
so only `_randomx_mine` on the pthread path was broken. The tab always takes that
path (`batch = max(64, cpuThreads * 32)`, threads 2–4).

Why the find rate still looked healthy: the wrong values are still uniform 256-bit
numbers, so the tab's own `hashDiff >= jobDiff` test kept firing at ~1/diff — one
submit per ~10 000 hashes at `+10000`, exactly as observed. gulf hashed the same
nonce itself and disagreed every time.

## Root cause

`src/cpp/softfloat.cpp` held the RandomX rounding mode in a **global**:

```c
uint_fast8_t globalRoundingMode = round_min;
```

wasm has no `fesetround`, so the port emulates it with that variable
(`intrin_wasm.cpp::setRoundMode_`). It is written by the bytecode `CFROUND`
instruction (`bytecode_machine.hpp:262`) during every program iteration and read by
`rx_*_vec_f128()` in `intrin_wasm.h`:

```c
if (globalRoundingMode == round_near_even) return wasm_f64x2_add(a, b);
softdouble rlo = …            // softfloat path
```

In the pthread build every VM shares it. Two hashing threads therefore clobber each
other's rounding mode mid-program — so a wrong value, a torn read, or even a switch
between the SIMD and softfloat implementations.

This also rules out every earlier hypothesis: the nonce offset (39, confirmed from the
varint header layout), the nonce endianness, the blob, the port, the dialect, the
pool's `construct_block_blob` reconstruction, `_randomx_hash` vs tevador, and "too
slow". `_randomx_hash` was always correct; only the *mining* path disagreed.

## Fix

1. `src/cpp/softfloat.hpp` + `softfloat.cpp`: `globalRoundingMode` and
   `globalDetectTininess` are now `__thread` (Emscripten 4.x TLS works in `-pthread`
   builds; verified with a standalone two-thread test).
2. `CMakeLists.txt`: added a `randomx-mt` library. In a `--shared-memory` link every
   object must declare the `atomics` feature (implied by `-pthread`), and the
   single-threaded `randomx` library must not carry it, so the two targets can no
   longer share one static library.
3. `js/miner-worker.js`: `solved` shares are re-hashed with the single-VM
   `_randomx_hash` before submit (`verifySolved()`); a mismatch drops the share and
   says so in the status log instead of feeding the pool a bad share (which also
   triggered the 10-minute `temporarily suspended` ban).
4. Cache-bust: wasm `?v=50` → `?v=51` in `js/miner-worker.js`, worker URL in
   `js/miner-client.js`, scripts in `index.html`.

## Verification (after rebuild)

```
t=1 target=diff64: nonce=5e5a5a5a  mine=7b59c498…be01  hash=7b59c498…be01  MATCH YES
t=2 target=diff64: nonce=5e5a5a5a  mine=7b59c498…be01  hash=7b59c498…be01  MATCH YES
t=3 target=diff64: nonce=5e5a5a5a  mine=7b59c498…be01  hash=7b59c498…be01  MATCH YES
t=2 accept-all x5                   stable, == hash(nonce)
throughput (cache-only, same box):  t=1 4.4 H/s   t=2 7.3 H/s   t=4 12.4 H/s
```

Independent native check, tevador RandomX on ARM (`/tmp/rx-local-test/hash_blob`,
light VM) against the same 76-byte gulf job blob and seed:

```
nonce 00000000 -> c3fd1bf138d2eb68b96c255a6fd045476eb61c7521878bddced5115a9258a234   (wasm == native)
nonce ddccbbaa -> 451ddb3635dc9768dcb423f71c07122e29df4d0e1883b58cf278f2ea528236ae   (wasm == native)
```

So the submitted `(nonce, result)` pair is now exactly what gulf recomputes.

## Rebuild

```sh
# overlay is in the web repo
cd /tmp/voltminer-web-push3/third_party/WebRandomX-overlay
git clone https://github.com/WebCryptomining/WebRandomX /tmp/WebRandomX-new
cd /tmp/WebRandomX-new && git checkout 780908a
cp -R /tmp/voltminer-web-push3/third_party/WebRandomX-overlay/. .
./build-web-randomx-mt.sh          # docker, emscripten/emsdk:4.0.10
cp build-mt/web-randomx-mt.{js,wasm} ../../../js/vendor/randomx/
```

`web-randomx.wasm` (single-thread fallback) is unchanged and still correct.

## Deploy + confirm

1. Ship `js/vendor/randomx/web-randomx-mt.wasm`, `js/vendor/randomx/web-randomx-mt.js`,
   `js/miner-worker.js`, `js/miner-client.js`, `index.html` (`?v=51`).
2. Hard-reload the tab, mine at `+30000` like the APK.
3. Expect `accepted` in the hash log and a `VMW-*` worker next to `AX-54686921` on the
   MoneroOcean dashboard — the first time the tab is credited.

Watch the log for the new guard text. If it ever appears, the wasm was built without
the thread-local rounding mode:

> Mining self-check failed: the wasm result is not the hash of its own nonce …

## Still open

* Only the tab's `rx/0` path is exercised here. `rx/wow` in the login algo list is
  never mined by this worker.
* Light/cache-only mode is ~4 H/s per thread; the 2 GB dataset path is what the app
  actually mines with. The rounding race was independent of the dataset, but the
  post-fix share rate should be re-measured end-to-end on the live pool.
* gulf's `Low difficulty share` string is still generic (it also covers invalid PoW),
  so any future regression looks like this one. The worker-side self-check is the
  cheapest way to tell them apart.
