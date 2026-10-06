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
SRC=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$SRC":/src -w /src emscripten/emsdk:4.0.10 sh -c '
  cd /src/wasm &&
  ST_BUILD=0 FIXED_MEMORY=1 INITIAL_MEMORY=3758096384 MAXIMUM_MEMORY=3758096384 sh ./build.sh
'
echo "built: $SRC/wasm/web-randomx-mt.wasm"
