#!/bin/sh
# Reproducible build of js/vendor/randomx/web-randomx-mt.{js,wasm}.
#
# Requires docker. Emscripten 4.0.10 (clang 21) is what produced the shipped
# binary; the container already has /emsdk at the path the CMake cache expects.
#
#   1. git clone https://github.com/WebCryptomining/WebRandomX && cd WebRandomX
#   2. git checkout 780908a
#   3. cp -R <this overlay>/. .        # CMakeLists.txt + src/cpp/*.cpp|hpp
#   4. ./build-web-randomx-mt.sh
#
# Output: build-mt/web-randomx-mt.{js,wasm} -> js/vendor/randomx/
set -e
SRC=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$SRC":/src -w /src emscripten/emsdk:4.0.10 sh -c '
  emcmake cmake -S /src -B /src/build-mt -DCMAKE_BUILD_TYPE=Release -DARCH=default &&
  cmake --build /src/build-mt --target web-randomx-mt -j4
'
echo "built: $SRC/build-mt/web-randomx-mt.wasm"
