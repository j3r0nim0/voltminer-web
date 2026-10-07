/*
Copyright (c) 2018-2019, tevador <tevador@gmail.com>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
	* Redistributions of source code must retain the above copyright
	  notice, this list of conditions and the following disclaimer.
	* Redistributions in binary form must reproduce the above copyright
	  notice, this list of conditions and the following disclaimer in the
	  documentation and/or other materials provided with the distribution.
	* Neither the name of the copyright holder nor the
	  names of its contributors may be used to endorse or promote products
	  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

#include <iostream>
#include <iomanip>
#include <stdexcept>
#include <sstream>
#include <cmath>
#include <cfloat>
#include "vm_interpreted.hpp"
#include "dataset.hpp"
#include <stdint.h>
#include "intrin_wasm.h"
#include "reciprocal.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
/* PORT: the wasm JIT's enable switch, as in the modern core -- it lives in this
   file because this is the only place that dispatches into the JIT. */
static int g_jitEnabled = 0;
extern "C" {
EMSCRIPTEN_KEEPALIVE
void rxSetJitEnabled(int enabled) { g_jitEnabled = enabled; }
}
namespace randomx {
	int rxjit_run_program_full(NativeRegisterFile&, Instruction[RANDOMX_PROGRAM_MAX_SIZE],
		const ProgramConfiguration&, uint8_t*, uint8_t*, uint64_t, uint32_t, uint32_t);
	int rxjit_run_program_light(NativeRegisterFile&, Instruction[RANDOMX_PROGRAM_MAX_SIZE],
		const ProgramConfiguration&, uint8_t*, randomx_cache*, uint64_t, uint32_t, uint32_t);
}

/* PORT: the JIT keeps its own thread-local rounding mode (0..3). Mirror
   softfloat's globalRoundingMode into it before a dispatch and back after, so
   an interpreter fallback (or the next program) sees the CFROUND updates the
   JIT just applied. */
extern __thread uint32_t wasm_rounding_mode;

static inline uint32_t rxjit_rounding_to_wasm() {
	switch (globalRoundingMode) {
	case round_min:    return 1; // down
	case round_max:    return 2; // up
	case round_minMag: return 3; // toward zero
	default:           return 0; // nearest
	}
}

static inline void rxjit_rounding_from_wasm(uint32_t mode) {
	switch (mode & 3) {
	case 1:  globalRoundingMode = round_min;       break;
	case 2:  globalRoundingMode = round_max;       break;
	case 3:  globalRoundingMode = round_minMag;    break;
	default: globalRoundingMode = round_near_even; break;
	}
}
#endif

namespace randomx {

	template<class Allocator>
	void InterpretedVm<Allocator>::setDataset(randomx_dataset* dataset) {
		datasetPtr = dataset;
		mem.memory = dataset->memory;
	}

	template<class Allocator>
	void InterpretedVm<Allocator>::run(void* seed) {
		VmBase<Allocator>::generateProgram(seed);
		randomx_vm::initialize();
		execute();
	}

	template<class Allocator>
	void InterpretedVm<Allocator>::execute() {

		NativeRegisterFile nreg;

		for(unsigned i = 0; i < RegisterCountFlt; ++i)
			nreg.a[i] = rx_load_vec_f128(&reg.a[i].lo);

		compileProgram(program, bytecode, nreg);

#ifdef __EMSCRIPTEN__
		if (g_jitEnabled) {
			/* cachePtr and datasetPtr share a union, so lightVm (set by
			   InterpretedLightVm::setCache) is what selects the light JIT:
			   in light mode the dataset items are computed from the cache. */
			wasm_rounding_mode = rxjit_rounding_to_wasm();
			int jitRan = 0;
			if (this->lightVm && this->cachePtr != nullptr)
				jitRan = rxjit_run_program_light(nreg, program.programBufferRaw(), config, scratchpad,
				                                 this->cachePtr, datasetOffset, mem.ma, mem.mx);
			else if (datasetPtr != nullptr)
				jitRan = rxjit_run_program_full(nreg, program.programBufferRaw(), config, scratchpad,
				                                mem.memory, datasetOffset, mem.ma, mem.mx);
			rxjit_rounding_from_wasm(wasm_rounding_mode);
			if (jitRan) {
				for (unsigned i = 0; i < RegistersCount; ++i) store64(&reg.r[i], nreg.r[i]);
				for (unsigned i = 0; i < RegisterCountFlt; ++i) rx_store_vec_f128(&reg.f[i].lo, nreg.f[i]);
				for (unsigned i = 0; i < RegisterCountFlt; ++i) rx_store_vec_f128(&reg.e[i].lo, nreg.e[i]);
				return;
			}
		}
#endif
		uint32_t spAddr0 = mem.mx;
		uint32_t spAddr1 = mem.ma;

		for(unsigned ic = 0; ic < RANDOMX_PROGRAM_ITERATIONS; ++ic) {
			uint64_t spMix = nreg.r[config.readReg0] ^ nreg.r[config.readReg1];
			spAddr0 ^= spMix;
			spAddr0 &= ScratchpadL3Mask64;
			spAddr1 ^= spMix >> 32;
			spAddr1 &= ScratchpadL3Mask64;
			
			for (unsigned i = 0; i < RegistersCount; ++i)
				nreg.r[i] ^= load64(scratchpad + spAddr0 + 8 * i);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				nreg.f[i] = rx_cvt_packed_int_vec_f128(scratchpad + spAddr1 + 8 * i);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				nreg.e[i] = maskRegisterExponentMantissa(config, rx_cvt_packed_int_vec_f128(scratchpad + spAddr1 + 8 * (RegisterCountFlt + i)));

			executeBytecode(bytecode, scratchpad, config);

			mem.mx ^= nreg.r[config.readReg2] ^ nreg.r[config.readReg3];
			mem.mx &= CacheLineAlignMask;
			datasetPrefetch(datasetOffset + mem.mx);
			datasetRead(datasetOffset + mem.ma, nreg.r);
			std::swap(mem.mx, mem.ma);

			for (unsigned i = 0; i < RegistersCount; ++i)
				store64(scratchpad + spAddr1 + 8 * i, nreg.r[i]);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				nreg.f[i] = rx_xor_vec_f128(nreg.f[i], nreg.e[i]);

			for (unsigned i = 0; i < RegisterCountFlt; ++i)
				rx_store_vec_f128((double*)(scratchpad + spAddr0 + 16 * i), nreg.f[i]);

			spAddr0 = 0;
			spAddr1 = 0;
		}

		for (unsigned i = 0; i < RegistersCount; ++i)
			store64(&reg.r[i], nreg.r[i]);

		for (unsigned i = 0; i < RegisterCountFlt; ++i)
			rx_store_vec_f128(&reg.f[i].lo, nreg.f[i]);

		for (unsigned i = 0; i < RegisterCountFlt; ++i)
			rx_store_vec_f128(&reg.e[i].lo, nreg.e[i]);
	}

	template<class Allocator>
	void InterpretedVm<Allocator>::datasetRead(uint64_t address, int_reg_t(&r)[RegistersCount]) {
		uintptr_t base = (uintptr_t)mem.memory;
		uint32_t off = (uint32_t)address;
		if (off > (uint32_t)(UINTPTR_MAX - base)) return;
		uint64_t* datasetLine = (uint64_t*)(base + (uintptr_t)off);
		for (int i = 0; i < RegistersCount; ++i)
			r[i] ^= datasetLine[i];
	}

	template<class Allocator>
	void InterpretedVm<Allocator>::datasetPrefetch(uint64_t address) {
		uintptr_t base = (uintptr_t)mem.memory;
		uint32_t off = (uint32_t)address;
		if (off > (uint32_t)(UINTPTR_MAX - base)) return;
		rx_prefetch_nta((uint8_t*)(base + (uintptr_t)off));
	}

	template class InterpretedVm<AlignedAllocator<CacheLineSize>>;
	template class InterpretedVm<LargePageAllocator>;
}