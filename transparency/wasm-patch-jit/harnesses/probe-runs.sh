#!/bin/bash
# Reproduce the MAX_THREADS 8->32 hash change, then verify the rs_ready fix.
cd /src
LOG=/src/build-mt/probe-log.txt; : > $LOG
NODE=$(echo /emsdk/node/*/bin/node)
EXP='["_malloc","_free","_randomx_hash","_randomx_mine","_randomx_set_threads","_randomx_get_threads","_rxSetJitEnabled","_rxjit_set_use_threaded_interp","_rxjit_set_feature","_rxjit_stat_runs","_rxjit_stat_light_runs","_rxjit_stat_fails","_randomx_alloc_cache","_randomx_init_cache","_randomx_release_cache","_randomx_create_vm","_randomx_destroy_vm","_randomx_calculate_hash","_randomx_get_flags"]'
BASE="-O3 -DNDEBUG -pthread -sINITIAL_MEMORY=1024MB -sMAXIMUM_MEMORY=1024MB -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=createWebRandomX -sENVIRONMENT=node,worker -sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=0 -sABORTING_MALLOC=0 -sSTACK_SIZE=1048576 -sDEFAULT_PTHREAD_STACK_SIZE=1048576 -msimd128 -mrelaxed-simd -sEXPORTED_RUNTIME_METHODS=HEAPU8"
LINK="@CMakeFiles/web-randomx-mt.dir/objects1.rsp @CMakeFiles/web-randomx-mt.dir/linklibs.rsp"
POOL8="-sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0"
POOLEXPR="-s 'PTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||8,32)' -sPTHREAD_POOL_SIZE_STRICT=0"

build()  { (cd /src/build-mt && cmake --build . --target web-randomx-mt -j8 >/tmp/build.log 2>&1) && echo "  build ok" || { echo "  BUILD FAILED"; tail -15 /tmp/build.log; }; }
link()   { (cd /src/build-mt && eval "em++ $BASE $3 -s EXPORTED_FUNCTIONS='$EXP' $LINK -o $1.cjs" >/tmp/link.log 2>&1) || { echo "  link $1 FAILED"; tail -4 /tmp/link.log; }; }
probe()  { RX_JS=/src/build-mt/$1.cjs RX_WASM=/src/build-mt/$1.wasm RX_TAG="$2" RX_SEQ="$SEQ" $NODE /src/probe-gen.mjs 2>&1 | tee -a $LOG; }
mt()     { sed -i "s/#define MAX_THREADS [0-9]*/#define MAX_THREADS $1/" src/cpp/web_randomx.cpp; }
unfix()  { sed -i "s/if (!rx_sp->rs_ready || rx_sp->rs_height/if (rx_sp->rs_height/" src/cpp/web_randomx.cpp; }
refix()  { sed -i "s/if (rx_sp->rs_height != seedheight/if (!rx_sp->rs_ready || rx_sp->rs_height != seedheight/" src/cpp/web_randomx.cpp; }

SEQ='0,0;0,0;0,1'
echo "### A: UNFIXED, MAX_THREADS 8 (baseline)" | tee -a $LOG
unfix; mt 8; build; link a_pool8 "$POOL8"; link a_expr "$POOLEXPR"; probe a_pool8 "A/MT8/pool8"; probe a_expr "A/MT8/expr"
echo "### B: UNFIXED, MAX_THREADS 32 (the reported failure)" | tee -a $LOG
mt 32; build; link b_pool8 "$POOL8"; link b_expr "$POOLEXPR"; probe b_pool8 "B/MT32/pool8"; probe b_expr "B/MT32/expr"
echo "### C: FIXED (rs_ready), MAX_THREADS 32" | tee -a $LOG
refix; build; link c_pool8 "$POOL8"; link c_expr "$POOLEXPR"; link c_full "$POOL8 -sINITIAL_MEMORY=3584MB -sMAXIMUM_MEMORY=3584MB"; probe c_pool8 "C/fix/MT32/pool8"; probe c_expr "C/fix/MT32/expr"
echo "### D: FIXED, MAX_THREADS 8" | tee -a $LOG
mt 8; build; link d_pool8 "$POOL8"; probe d_pool8 "D/fix/MT8/pool8"
link d_full "$POOL8 -sINITIAL_MEMORY=3584MB -sMAXIMUM_MEMORY=3584MB" ; probe d_full "D/fix/MT8/full-mem"
echo "### done" | tee -a $LOG
