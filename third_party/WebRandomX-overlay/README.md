# WebRandomX overlay

Patches on [WebCryptomining/WebRandomX](https://github.com/WebCryptomining/WebRandomX) (`780908a`).

Not a full RandomX tree. Copy these files over a clone, then Emscripten-build `web-randomx-mt`.

| File | Why |
|---|---|
| `src/cpp/web_randomx.cpp` | LE nonce at blob[39], dataset fill, `_randomx_mine`, pthread VMs |
| `src/cpp/vm_interpreted.cpp` | wasm32 unsigned dataset pointer (OOB past 2 GB) |
| `CMakeLists.txt` | pthread target, pinned ~3584 MB heap, `-O3 -msimd128` |
| `against-upstream-780908a.patch` | same as `git diff` vs that commit |

Shipped binaries: `js/vendor/randomx/web-randomx-mt.wasm` (and the ST `web-randomx.wasm`).
