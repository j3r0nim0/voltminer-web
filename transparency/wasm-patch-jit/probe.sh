#!/bin/bash
# Compile each wasm JIT translation unit against the 2019 WebRandomX core headers.
cd /src
for f in jit/*.c jit/*.cpp; do
  [ -f "$f" ] || continue
  printf "%-36s " "$f"
  case "$f" in
    *.c)   out=$(emcc -c -O1 -I src/cpp -msimd128 "$f" -o /tmp/o.o 2>&1) ;;
    *.cpp) out=$(emcc -c -O1 -std=gnu++17 -I src/cpp -msimd128 "$f" -o /tmp/o.o 2>&1) ;;
  esac
  if [ $? -eq 0 ]; then
    echo "COMPILES"
  else
    echo "FAILS"
    echo "$out" | grep -E "fatal error|error:" | sed 's/^/       /' | head -2
  fi
done
echo
echo "=== does the 2019 core define DecodedSuperscalarProgram? ==="
grep -rn "DecodedSuperscalarProgram" src/cpp/ | head -3 || echo "  ABSENT in the 2019 core"
echo "=== and intrin_portable.h? ==="
ls src/cpp/intrin_portable.h 2>/dev/null || echo "  ABSENT in the 2019 core (it has intrin_wasm.h instead)"
