#!/bin/bash
cd /src/build-mt
EXP='["_malloc","_free","_randomx_hash","_rxSetJitEnabled","_rxjit_set_use_threaded_interp","_rxjit_set_feature","_rxjit_set_profile","_rxjit_set_regs_in_memory","_rxjit_set_split_inner_dispatch","_rxjit_stat_runs","_rxjit_stat_light_runs","_rxjit_stat_fails"]'
/emsdk/upstream/emscripten/em++ -O3 -DNDEBUG -pthread -sWASM=1 -sMODULARIZE=1 \
  -sEXPORT_NAME=createWebRandomX -sENVIRONMENT=node,worker -sWASM_BIGINT=1 \
  -sINITIAL_MEMORY=1024MB -sMAXIMUM_MEMORY=1024MB -sALLOW_MEMORY_GROWTH=0 -sABORTING_MALLOC=0 \
  -s 'PTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||8,32)' -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sSTACK_SIZE=1048576 -sDEFAULT_PTHREAD_STACK_SIZE=1048576 -msimd128 -mrelaxed-simd \
  -s "EXPORTED_FUNCTIONS=$EXP" -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  @CMakeFiles/web-randomx-mt.dir/objects1.rsp @CMakeFiles/web-randomx-mt.dir/linklibs.rsp -o rxtest3.cjs
