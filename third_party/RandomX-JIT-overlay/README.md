# RandomX-JIT overlay

Our changes on top of [aa022/RandomX-bonanza](https://github.com/aa022/RandomX-bonanza)
(`f9848e3`) — the wasm JIT engine vendored at `third_party/RandomX-JIT/`.

Not a full RandomX tree. Copy these files over a clone of that commit, then
Emscripten-build the shared-memory `web-randomx-mt`.

| File | Why |
|---|---|
| `wasm/src/src/web_randomx.cpp` | our API shim: LE nonce at blob[39], `_randomx_mine`, the `randomx_dataset_*` chunked API, pthread VMs |
| `wasm/src/src/web_randomx.h` | 16 lines defining `EM_PORT_API` (reused from WebRandomX; not in the bonanza tree) |
| `wasm/build.sh` | bonanza's script with three edits: our shim added to `SOURCES`, our 12 `_randomx_*` export names added to `EXPORTED_FUNCTIONS`, and the pthread link retargeted to `web-randomx-mt.js`. Our flags: `-s EXPORT_NAME=createWebRandomX`, `-s ENVIRONMENT="${RX_ENVIRONMENT:-worker}"`, `PTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||8,32)`, `EXPORTED_RUNTIME_METHODS=HEAPU8`. |
| `against-upstream-f9848e3.patch` | the same change as `git diff` vs that commit |
| `build-web-randomx-mt.sh` | docker build that reproduces the shipped binary. Leaves memory **growable** (bonanza's default: `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4 GiB`), so the mt build commits ~16 MiB at load and grows to the JIT's 4 GiB ceiling only if a full-dataset run needs it. An earlier revision forced `FIXED_MEMORY=1` at 3584 MiB, which committed that heap on load in every mode — including light — and swapped a 16 GB machine to death. |

Shipped artifact: `js/vendor/randomx/web-randomx-mt.wasm` (and `.js`).

Threads: the shim caps C++ threads at `MAX_THREADS 32` and the pthread pool is sized to the machine (`navigator.hardwareConcurrency`, capped at 32), so an 8-core box pre-warms 8 workers and a workstation can use up to 32. The miner slider works in percent of cores.

## Hash correctness: first-call cache init (fixed 2026-10-07)

`cache_for()` decided whether to call `randomx_init_cache()` by comparing the request against
`rx_s[slot]`, which starts life as `{hash = 32 x 0x00, height = 0}`. A request for
`(seedheight 0, seedhash 32 x 0x00)` therefore matched the fresh state on the **first** call:
the cache was never filled and the hash came out of a `malloc`'d 256 MiB buffer whose contents
were whatever the allocator happened to hand back — so the value moved with the heap layout
(the same source with `MAX_THREADS 8 -> 32` returns `2f31bdb9...` instead of `30aed56e...`).

Production calls pass `(height, height)` with the real epoch seed, so they always initialised
and no share was ever at risk (only heights <= 2112 use the zero seed). The casualty was the
load-time self-test, which compared against the uninitialised-cache value rather than
`086a612e...5f3` — the vector's real RandomX v1 hash, the one the interpreter, the JIT and
tevador's official vector all agree on.

Fixed with an `rs_ready` flag: the first call on a slot always initialises, and the engine's own
`randomx_init_cache()` short-circuits an unchanged, initialised key afterwards, so steady-state
cost is unchanged. The self-test now also hashes at height 1, which forces the cache to be built
on every engine we ship.

Shipped artifact: `js/vendor/randomx/web-randomx-mt.wasm`, sha256
`df4a74370e18af24b226e13285abbc0db65596cca5a78af427fb7625d194e533` (270,966 B).

## Why this base and not WebRandomX

The previous tree was WebRandomX plus patches, one of which made softfloat's
process-global FP rounding mode thread-local — the bug that made every share
rejected. This tree has no softfloat at all (`rx_vec_f128` is `__m128d`, wasm
SIMD doubles), so the hazard is absent rather than fixed, and the shim runs on it
unmodified. Provenance and per-file licences are in `third_party/RandomX-JIT/NOTICE`.

## Licensing note

`wasm/src/src/jit_stubs/semifloat.c` and `mulh.c` in the base tree are
byte-identical to [l1mey112/randomx.js](https://github.com/l1mey112/randomx.js)
(BSD-3-Clause, tevador and l-m); they are the one obligation the base tree's CC0
JIT does not cover and are credited in `notices.html`.
