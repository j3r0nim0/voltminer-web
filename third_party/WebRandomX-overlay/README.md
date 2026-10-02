# WebRandomX overlay

Patches on [WebCryptomining/WebRandomX](https://github.com/WebCryptomining/WebRandomX) (`780908a`).

Not a full RandomX tree. Copy these files over a clone, then Emscripten-build `web-randomx-mt`.

| File | Why |
|---|---|
| `src/cpp/web_randomx.cpp` | LE nonce at blob[39], dataset fill, `_randomx_mine`, pthread VMs |
| `src/cpp/vm_interpreted.cpp` | wasm32 unsigned dataset pointer (OOB past 2 GB) |
| `src/cpp/softfloat.hpp` / `softfloat.cpp` | **thread-local FP rounding mode** — a shared global made every multi-threaded hash wrong (see below) |
| `CMakeLists.txt` | pthread target, pinned ~3584 MB heap, `-O3 -msimd128`, dedicated `randomx-mt` library |
| `against-upstream-780908a.patch` | same as `git diff` vs that commit |
| `build-web-randomx-mt.sh` | docker build that reproduces the shipped binary |

Shipped binaries: `js/vendor/randomx/web-randomx-mt.wasm` (and the ST `web-randomx.wasm`).

## The pthread rounding-mode race (fixed 2026-10-02)

`softfloat.cpp` kept the RandomX floating-point rounding mode in a plain global:

```c
uint_fast8_t globalRoundingMode = round_min;
```

On wasm there is no `fesetround`, so the port emulates it with that variable
(`intrin_wasm.cpp::setRoundMode_`). It is written by the bytecode `CFROUND`
instruction (`bytecode_machine.hpp:262`) *during every program iteration* and read by
`rx_*_vec_f128()` in `intrin_wasm.h`, which picks between the fast wasm SIMD path
and a softfloat path based on it.

With one VM per pthread and `_randomx_mine` running N of them concurrently, every
thread clobbered the same variable. Both hashes came back wrong — non-deterministically,
and often without the target being met by the reported hash at all:

```
t=1 target=diff64: nonce=5e5a5a5a   mine=7b59c498…be01   hash(nonce)=7b59c498…be01   MATCH YES
t=2 t=2 max=64     nonce=01000000   mine=0f57199e…e64d   hash(nonce)=49e4bc7a…76db   MATCH NO
t=4 t=4 max=128    nonce=44332211   mine=26c027fd…e49b   hash(nonce)=1324e537…c93a   MATCH NO
```

The miner's local target check still passed at ~1/diff (the wrong values are still
uniform 256-bit values), so the tab submitted ~1 share per 10 000 hashes and gulf
answered **Low difficulty share** every time: it rebuilt the blob, hashed the nonce we
sent, and got a different 256-bit number. The Android build was never affected — it
uses XMRig, which has a real per-thread FENV.

Fix: both softfloat globals are `__thread` (Emscripten 4.x supports TLS in `-pthread`
builds). Each hashing thread then keeps its own mode. Same verified blob+nonce now
matches native tevador RandomX byte for byte.

Also: `randomx-mt` is its own static library. In a `--shared-memory` wasm link *every*
object must declare the `atomics` target feature, which `-pthread` implies; the
single-threaded `randomx` library must not carry it, so the two cannot share one.
