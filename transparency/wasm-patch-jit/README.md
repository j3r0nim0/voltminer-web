# WebRandomX-JIT overlay (the engine shipped from ?v=68)

The pthread engine in `js/vendor/randomx/web-randomx-mt.{js,wasm}`, and the JIT for the
single-thread `web-randomx.{js,wasm}`. Base: [WebCryptomining/WebRandomX](https://github.com/WebCryptomining/WebRandomX)
`780908a`, plus the wasm JIT vendored from [aa022/RandomX-bonanza](https://github.com/aa022/RandomX-bonanza)
`f9848e3` (in `jit/`). Not a full RandomX tree: copy these files over a clone of the base,
then build with `build-web-randomx-mt.sh`.

| File | Why |
|---|---|
| `CMakeLists.txt` | two shipped targets (pthread + single-thread), growable memory, plain SIMD, cap 32 threads |
| `src/cpp/web_randomx.cpp` | our shim: LE nonce at blob[39], `_randomx_mine`, chunked `randomx_dataset_*`, pthread VMs, `rs_ready` cache fix |
| `src/cpp/dataset.cpp` / `dataset.hpp` | superscalar programs pre-decoded into the cache (`decodedPrograms`) for the light-mode JIT kernel |
| `src/cpp/superscalar.*`, `program.hpp`, `virtual_machine.hpp` | decodedProgram form + `programBufferRaw()` the JIT dispatches on |
| `src/cpp/vm_interpreted*.cpp` | light/full JIT dispatch (`rxjit_run_program_light` / `_full`) with rounding-mode sync |
| `src/cpp/softfloat.{cpp,hpp}` | thread-local FP rounding globals (the pthread rounding race) |
| `src/cpp/rxjit_globals.cpp` | definitions the vendored JIT links against (`g_rx_aes_*`, `wasm_rounding_mode`) |
| `jit/` | the vendored wasm JIT sources |
| `harnesses/` | node probes used to verify it (KAT, official vector, heap-poison, full dataset, thread cap) |

## Engine properties (why this build and not bonanza's)

* **Memory**: `ALLOW_MEMORY_GROWTH=1`, `MAXIMUM_MEMORY=4GB` (pthread) / `3072MB` (single-thread).
  Never a fixed 3.5 GiB heap: that committed the whole heap on load, light mode included.
* **SIMD**: `-msimd128 -mrelaxed-simd` are needed to *compile* `jit/jit_stubs/semifloat.c`
  (`wasm_f64x2_relaxed_madd`), but those paths are dead-stripped: `llvm-objdump -d` shows
  **zero** relaxed-SIMD instructions in either shipped module, so the browser requirement is the
  same as bonanza's (whose main wasm is deliberately relaxed-free for JSC).
* **Cache correctness**: `rs_ready` makes the first call on a cache slot always run
  `randomx_init_cache()`. Without it a request for `(seedheight 0, seedhash 32 x 0x00)` matched
  the zero-initialised state and hashed an uninitialised 256 MiB buffer — a value that moved with
  the heap layout. Production calls pass `(height, height)` with the real seed and were never
  affected; the load-time self-test was. See `docs/BACKLOG.md` D3.

## Verification (2026-10-07, against the staged bytes)

* KAT exactly as `js/miner-worker.js` / `js/diag.js` call it (`_randomx_hash(1n, 1n, ...)`):
  `086a612e65232b12f9f5bc5e1c36b1215c51273f46a9a96e70a9d35a150645f3` — MATCH on both builds.
* tevador's official vector `8a48e5f9...b7c9`: MATCH in interpreter **and** JIT, both builds.
* light == full (2 GB dataset, ~100 s) == the KAT value (`harnesses/verify-full.mjs`).
* the pthread wasm is byte-identical to a same-objects/same-exports node relink, so the artifact
  tested is the artifact shipped.
