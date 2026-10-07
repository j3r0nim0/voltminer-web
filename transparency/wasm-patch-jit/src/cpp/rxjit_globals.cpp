/*
PORT adapter: definitions the vendored wasm JIT (jit/) links against but the
2019 WebRandomX core does not provide.

Upstream (RandomX-bonanza) defines these in soft_aes.cpp and
instructions_portable.cpp. The 2019 core folds the AES path into soft_aes.hpp
and models the FPU rounding mode with softfloat's thread-local
globalRoundingMode, so only the two storage symbols the JIT references
directly are left to provide here.

  g_rx_aes_simd / g_rx_aes_relaxed
      Feature flags the JIT reads via rxjit_set_feature(). This port has a
      single (T-table) C-side AES, bit-exact with the JIT's SIMD AES, so the
      flags exist only to satisfy the JIT's declarations and its
      rxjit_effective_* getters.

  wasm_rounding_mode
      The JIT's thread-local FP rounding mode in its own 0..3 encoding
      (0 = nearest, 1 = down, 2 = up, 3 = zero). vm_interpreted.cpp mirrors it
      to/from softfloat's globalRoundingMode around every JIT dispatch, so the
      interpreter and the JIT can never disagree on the mode.
*/

#include <cstdint>

extern "C" int g_rx_aes_simd = 0;
extern "C" int g_rx_aes_relaxed = 0;

__thread uint32_t wasm_rounding_mode = 0;
