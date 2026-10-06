# RandomX-JIT overlay

Our changes on top of [aa022/RandomX-bonanza](https://github.com/aa022/RandomX-bonanza)
(`f9848e3`) — the wasm JIT engine vendored at `third_party/RandomX-JIT/`.

Not a full RandomX tree. Copy these files over a clone of that commit, then
Emscripten-build the shared-memory `web-randomx-mt`.

| File | Why |
|---|---|
| `wasm/src/src/web_randomx.cpp` | our API shim: LE nonce at blob[39], `_randomx_mine`, the `randomx_dataset_*` chunked API, pthread VMs |
| `wasm/src/src/web_randomx.h` | 16 lines defining `EM_PORT_API` (reused from WebRandomX; not in the bonanza tree) |
| `wasm/build.sh` | bonanza's script with three edits: our shim added to `SOURCES`, our 12 `_randomx_*` export names added to `EXPORTED_FUNCTIONS`, and the pthread link retargeted to `web-randomx-mt.js`. Our flags: `-s EXPORT_NAME=createWebRandomX`, `-s ENVIRONMENT=worker`, `PTHREAD_POOL_SIZE=8`, `EXPORTED_RUNTIME_METHODS=HEAPU8`. |
| `against-upstream-f9848e3.patch` | the same change as `git diff` vs that commit |
| `build-web-randomx-mt.sh` | docker build that reproduces the shipped binary. Leaves memory **growable** (bonanza's default: `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4 GiB`), so the mt build commits ~16 MiB at load and grows to the JIT's 4 GiB ceiling only if a full-dataset run needs it. An earlier revision forced `FIXED_MEMORY=1` at 3584 MiB, which committed that heap on load in every mode — including light — and swapped a 16 GB machine to death. |

Shipped artifact: `js/vendor/randomx/web-randomx-mt.wasm` (and `.js`).

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
