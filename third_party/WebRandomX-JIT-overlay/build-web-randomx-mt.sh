#!/bin/sh
# Reproducible build of js/vendor/randomx/web-randomx-mt.{js,wasm} and
# web-randomx.{js,wasm} shipped from ?v=68.
#
#   1. git clone https://github.com/WebCryptomining/WebRandomX && cd WebRandomX
#   2. git checkout 780908a
#   3. cp -R <this overlay>/. .        # sources, CMakeLists, jit/
#   4. ./build-web-randomx-mt.sh
#
# Requires docker (emscripten/emsdk:4.0.10, clang 21 -- what produced the shipped
# binaries). Output: build-mt/web-randomx-mt.wasm + build-mt/web-randomx.wasm.
set -e
SRC=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$SRC":/src -w /src emscripten/emsdk:4.0.10 bash -c '
  cmake -S /src -B /src/build-mt -DCMAKE_BUILD_TYPE=Release >/dev/null &&
  cmake --build /src/build-mt --target web-randomx web-randomx-mt -j8
'
echo "built: $SRC/build-mt/web-randomx-mt.wasm + web-randomx.wasm"
