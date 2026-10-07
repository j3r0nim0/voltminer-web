#!/bin/bash
set -e
cd /src/build-mt
EXP=$(cat /src/exp.json)
em++ -O3 -DNDEBUG -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createWebRandomX -sENVIRONMENT=node,worker \
  -sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sABORTING_MALLOC=0 -msimd128 -mrelaxed-simd -pthread \
  -s 'PTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||8,32)' -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sSTACK_SIZE=1048576 -sDEFAULT_PTHREAD_STACK_SIZE=1048576 -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -s "EXPORTED_FUNCTIONS=$EXP" \
  @CMakeFiles/web-randomx-mt.dir/objects1.rsp @CMakeFiles/web-randomx-mt.dir/linklibs.rsp -o check_staged.cjs >/tmp/c.log 2>&1 || { tail -5 /tmp/c.log; exit 1; }
echo "check_staged.wasm $(stat -c%s check_staged.wasm) B"
