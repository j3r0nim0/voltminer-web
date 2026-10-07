#!/bin/bash
# Relink the port's objects as node+worker CJS artifacts in the SHIPPING
# configuration (growable memory, plain SIMD, self-sizing pthread pool), plus
# the classic randomx_* API so bench/canonical-style checks can drive the core.
#   rxtest.cjs/.wasm     pthread build   (shipping MT memory model: growable, 4 GiB cap)
#   rxtest_st.cjs/.wasm  single-thread   (shipping ST memory model: growable, 3072 MiB cap)
set -e
cd /src/build-mt
EXP='["_malloc","_free","_randomx_hash","_randomx_mine","_randomx_set_threads","_randomx_get_threads","_randomx_is_full_mem","_randomx_dataset_begin","_randomx_dataset_step","_randomx_dataset_percent","_randomx_dataset_ptr","_randomx_dataset_items","_randomx_dataset_item_bytes","_randomx_dataset_mark_ready","_rxSetJitEnabled","_rxjit_set_feature","_rxjit_set_regs_in_memory","_rxjit_set_split_inner_dispatch","_rxjit_set_profile","_rxjit_set_max_memory_pages","_rxjit_set_use_threaded_interp","_rxjit_stat_runs","_rxjit_stat_light_runs","_rxjit_stat_fails","_randomx_alloc_cache","_randomx_init_cache","_randomx_release_cache","_randomx_create_vm","_randomx_destroy_vm","_randomx_calculate_hash","_randomx_get_flags"]'
COMMON="-O3 -DNDEBUG -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createWebRandomX -sENVIRONMENT=node,worker -sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=1 -sABORTING_MALLOC=0 -msimd128 -sEXPORTED_RUNTIME_METHODS=HEAPU8"
eval "em++ $COMMON -pthread -sMAXIMUM_MEMORY=4GB -s 'PTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||8,32)' -sPTHREAD_POOL_SIZE_STRICT=0 -sSTACK_SIZE=1048576 -sDEFAULT_PTHREAD_STACK_SIZE=1048576 -s EXPORTED_FUNCTIONS='$EXP' @CMakeFiles/web-randomx-mt.dir/objects1.rsp @CMakeFiles/web-randomx-mt.dir/linklibs.rsp -o rxtest.cjs" >/tmp/l1.log 2>&1 || { echo MT-LINK-FAIL; tail -5 /tmp/l1.log; exit 1; }
echo "rxtest.cjs   pool=$(grep -o 'var pthreadPoolSize=[^;]*' rxtest.cjs) wasm=$(stat -c%s rxtest.wasm)"
eval "em++ $COMMON -sINITIAL_MEMORY=272MB -sMAXIMUM_MEMORY=3072MB -s EXPORTED_FUNCTIONS='$EXP' @CMakeFiles/web-randomx.dir/objects1.rsp @CMakeFiles/web-randomx.dir/linklibs.rsp -o rxtest_st.cjs" >/tmp/l2.log 2>&1 || { echo ST-LINK-FAIL; tail -5 /tmp/l2.log; exit 1; }
echo "rxtest_st.cjs wasm=$(stat -c%s rxtest_st.wasm)"
