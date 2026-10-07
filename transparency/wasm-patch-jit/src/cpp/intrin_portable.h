#pragma once
/* Adapter for the wasm JIT port.
   The JIT sources include "intrin_portable.h", upstream RandomX's portable
   intrinsics layer. The 2019 WebRandomX core predates it and ships
   intrin_wasm.h instead, which defines the same rx_vec_f128 (v128_t, i.e. wasm
   SIMD doubles, not softfloat). The JIT needs very little from here, so this
   forwards to the core's own header rather than pulling upstream's 1,100-line
   version in.
   wasm_softround.h supplies softround_add/sub/mul, which the generated code
   calls when CFROUND has set a non-default rounding mode; it reads the core's
   thread-local globalRoundingMode so both paths round identically. */
#include "intrin_wasm.h"
#include "wasm_softround.h"
