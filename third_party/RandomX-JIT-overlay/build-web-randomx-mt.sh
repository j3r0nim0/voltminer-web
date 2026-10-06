#!/bin/sh
# Reproducible build of js/vendor/randomx/web-randomx-mt.{js,wasm}.
#
# Requires docker. Emscripten 4.0.10 (clang 21) is what produced the shipped
# binary. clang-19 is absent from that image, so the committed relaxed-SIMD AES
# blob in the tree is kept (wasm/build.sh falls back) — which is what the
# shipped binary contains too.
#
#   1. git clone https://github.com/aa022/RandomX-bonanza && cd RandomX-bonanza
#   2. git checkout f9848e3
#   3. cp -R <this overlay>/. .        # wasm/build.sh + wasm/src/src/web_randomx.{cpp,h}
#   4. ./build-web-randomx-mt.sh
#
# Output: wasm/web-randomx-mt.{js,wasm} -> js/vendor/randomx/
#
# The pthread build only: the single-thread js/vendor/randomx/web-randomx.{js,wasm}
# is still the earlier WebRandomX build (see third_party/WebRandomX-overlay/).
set -e
#
# Memory: growable, bonanza's own default (-s ALLOW_MEMORY_GROWTH=1
# -s MAXIMUM_MEMORY=4294967296). An earlier revision forced
# FIXED_MEMORY=1 INITIAL_MEMORY=MAXIMUM_MEMORY=3.5 GiB, which committed that
# heap on load in every mode and pushed a 16 GB machine into swap. Its only
# value is a fixed base for the JIT's memory.pages ceiling; growable memory
# still lets a full-dataset run reach the same 4 GiB cap, and light mode stays
# small. If memory.grow on the shared memory ever misbehaves, the fallback is a
# fixed heap sized for light mode — not 3.5 GiB.
# bash, not sh: the image's /bin/sh is dash and build.sh uses bash arrays.
SRC=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$SRC":/src -w /src emscripten/emsdk:4.0.10 bash -c '
  cd /src/wasm &&
  ST_BUILD=0 bash ./build.sh
'
echo "built: $SRC/wasm/web-randomx-mt.wasm"
