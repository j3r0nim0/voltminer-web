# RandomX Cross-Project Optimization Roadmap: Web Wasm to Native ARM64 (Anvil)

This document synthesizes the empirical microarchitectural discoveries from the **VoltMiner Web** project (Phases 6 & 7) and establishes concrete engineering frontiers and implementation recipes for **Anvil** (`android-xmrig-monero`), the native Android XMRig miner.

---

## 1. Proven Discoveries from VoltMiner (WebRandomX JIT)

| Frontier / Mechanism | Microarchitectural Mechanism | Empirical Impact | Root Cause & Insight |
| :--- | :--- | :---: | :--- |
| **Compact Zero-Extension** (`wasm_jit_superscalar`) | Replaced 7-byte LEB `0xffffffff` + `i64.and` with canonical 2-byte `i32.wrap_i64` + `i64.extend_i32_u`. | **+25% on Safari Light Mode** (70 $\rightarrow$ 95 H/s) | Shrank compiled bytecode below WebKit OMG optimizing JIT limit, avoiding tier-up bailout. |
| **Dual-Offset DRAM Burst Prefetch** (`wasm_jit_threaded`) | Prefetching offset 0 and offset 32 of next dataset line via non-blocking loads. | **+25% on Chrome Fast Mode** (390 $\rightarrow$ 510 H/s on 4 cores) | Matches Apple Silicon / LPDDR5 32-byte channel burst interleave. Prefetching offset 0 only fetches the first half. |
| **Critical-Path Load Scheduling** | Issued dataset prefetch after Step 7 vector XORs rather than immediately before. | **+3.3% to +5.5% sustained** (V8 peak 121.7 H/s, JSC peak 137.2 H/s) | Removes memory bus contention between prefetch issued to DRAM and critical-path vector loads from cache. |
| **ARM64 Register Allocation Ceiling** | Adding locals to `ItemLocals` (32 $\rightarrow$ 36 locals). | **-10.9% severe regression** (Rejected) | Exceeded physical ARM64 general-purpose register count (28 usable GPRs), inducing stack spills in the inner loop. |
| **Adaptive Duty-Cycle Governor** | Micro-pauses (8–15ms) between batch execution slices (120ms budget). | **Zero thermal cliff** (eliminates drop from 590 to 430 H/s) | Allows continuous passive heat dissipation through the chassis, sustaining peak 4.05 GHz boost clocks. |

---

## 2. Transferable Frontiers for Native ARM64 / Android (Anvil)

### Frontier 1: Eliminating the ARM64 FPCR Floating-Point Pipeline Flush
* **Microarchitectural Problem**:
  In RandomX VM programs, floating-point operations dynamically alter IEEE 754 rounding modes (`round down`, `round up`, `round to nearest`, `round toward zero`). In standard ARM64 implementations, changing the rounding mode writes to the Floating-Point Control Register:
  ```assembly
  msr fpcr, x_val
  ```
  On modern out-of-order ARM64 mobile cores (Cortex-X1/X2/X3/X4, Cortex-A77/A78/A710/A715/A720), writing to `FPCR` is a **serializing instruction** that forces a **full CPU pipeline flush**—all in-flight speculative instructions in the Reorder Buffer (ROB) must drain and stall.
* **The Breakthrough Theory**:
  ARMv8-A includes native instruction-level floating-point rounding instructions that do **not** depend on `FPCR`:
  - `frintn` (Round to Nearest, ties to even)
  - `frintm` (Round toward Minus Infinity / Floor)
  - `frintp` (Round toward Plus Infinity / Ceil)
  - `frintz` (Round toward Zero / Truncate)
* **Actionable Implementation**:
  In RandomX native JIT / assembly (`randomx_arm.S` / `RxVm_arm.cpp`), replace dynamic `FPCR` register writes with direct emission of the corresponding `frint*` instruction for each rounding mode. This completely eliminates CPU pipeline serialization stalls in the VM loop.

---

### Frontier 2: Heterogeneous CPU Topology & DynamIQ Core Pinning
* **Microarchitectural Problem**:
  RandomX requires **2 MiB of L3 cache per fast thread**. On mobile SoCs (Snapdragon 865, 8 Gen 1/2/3, Dimensity 9000/9300, Helio G99), the shared System-Level Cache (SLC) is only 4–8 MiB.
  As proven on the Snapdragon 865 (4 Big + 4 Little cores):
  - **4 threads (all Big cores)**: **748 H/s (Peak)**
  - **8 threads (all cores)**: **684 H/s (-9% regression)**
  The 4 Cortex-A55 Little cores (with tiny 64 KB L2) constantly evict the Big cores' 2 MiB scratchpads from L3 and congest the shared memory bus.
* **Actionable Implementation**:
  1. Inspect CPU topology via `/sys/devices/system/cpu/cpu*/topology/` or `cpuinfo_max_freq` at startup.
  2. Map cores into **Prime (Cortex-X)**, **Performance (Cortex-A7x)**, and **Efficiency (Cortex-A5x)** masks.
  3. Enforce strict `sched_setaffinity` core affinity:
     - Worker threads pinned exclusively to Prime and Performance cores.
     - Move network I/O, Stratum polling, and UI threads to Efficiency Core 0 so mining threads execute without OS interruption.

---

### Frontier 3: Dual-Burst Native DRAM Prefetching (`prfm`)
* **Microarchitectural Problem**:
  Standard RandomX ARM64 assembly issues a single prefetch instruction at offset 0 (`prfm pldl1keep, [x_dataset_ptr]`). However, mobile LPDDR4X and LPDDR5 memory controllers use 16-byte or 32-byte channel interleaving. Prefetching only offset 0 leaves bytes 32–63 stalled in memory controller queues.
* **Actionable Implementation**:
  In native ARM64 assembly:
  ```assembly
  // Issue dual subchannel burst prefetch:
  prfm pldl1keep, [x_dataset_ptr, #0]
  prfm pldl1keep, [x_dataset_ptr, #32]
  ```
  Benchmark prefetch distances ($D = 1$ iteration vs $D = 2$ iterations ahead) to completely hide DRAM latency behind integer/FPU execution.

---

### Frontier 4: W^X Dual-Mapping JIT Allocator for Modern Android (API 29+)
* **Microarchitectural Problem**:
  On Android 10+ (API 29–15), strict SELinux policies enforce W^X (Write XOR Execute) and prevent `mprotect(PROT_READ | PROT_WRITE | PROT_EXEC)`. If JIT memory allocation fails, XMRig silently falls back to interpreted mode, degrading hashrate by **3x to 4x**.
* **Actionable Implementation**:
  Implement dual virtual mapping of anonymous shared memory via `ashmem` or Linux `memfd_create`:
  - Mapping 1: `PROT_READ | PROT_WRITE` (used by compiler to generate ARM64 instructions).
  - Mapping 2: `PROT_READ | PROT_EXEC` (used by the CPU execution thread).
  Guarantees high-speed native JIT compilation across all modern locked-down Android devices without root privileges.

---

### Frontier 5: Adaptive Duty-Cycle Governor vs. Hard Thermal Tripwires
* **Microarchitectural Problem**:
  Phone cooling is strictly passive (no fans, 3.5W–5W heat dissipation envelope). When mining flat out, phone junction temperatures reach 80°C+ within 60–90 seconds. Android’s kernel `thermal-engine` severely throttles CPU clocks down from 2.84 GHz to 1.2 GHz. Hard pauses (`cpu pause 65°C`, `battery pause 40°C`) cause inefficient stop-and-go oscillations.
* **Actionable Implementation**:
  Port the VoltMiner **Frontier C Adaptive Governor**:
  - Insert calibrated micro-pauses (5–15ms) between hash slices.
  - Dynamically throttle the duty cycle (e.g. 90–92%) when hashrate degrades by >12%, allowing continuous passive heat transfer into the chassis.
  - Maintains peak clock frequencies indefinitely without triggering kernel DVFS throttling cliffs.

---

### Frontier 6: DTLB Miss Reduction via Transparent Huge Pages (THP)
* **Microarchitectural Problem**:
  A 2.08 GB dataset and 2 MB scratchpads backed by standard 4 KB pages consume hundreds of TLB entries. Mobile ARM64 L1 TLB has only 32–64 entries, causing constant 4-level page table walks during RandomX random memory accesses.
* **Actionable Implementation**:
  In scratchpad and dataset allocation:
  ```c
  madvise(addr, size, MADV_HUGEPAGE);
  ```
  Pre-fault pages sequentially before mining to ensure contiguous 2 MB physical page mapping, reducing DTLB misses by up to 80%.

---

## 3. Recommended Phased Execution Plan for Anvil

1. **Phase 1: Big-Core CPU Affinity Masking**:
   - Update Anvil's config generator (`app/src/main/java/...`) to detect big cores and emit the optimal CPU affinity mask in `config.json`.
   - Validate on Qualcomm (Snapdragon 865 / 8 Gen 2) and MediaTek (Helio G99 / Dimensity).
2. **Phase 2: Native ARM64 Dual-Burst Prefetch & FPCR Elimination**:
   - Patch `randomx_arm.S` and `RxVm_arm.cpp` in the MoneroOcean XMRig fork.
   - Cross-compile with NDK 28 (`docs/BUILD-XMRIG.md`).
   - Benchmark with `./xmrig --bench=1M`.
3. **Phase 3: Adaptive Duty-Cycle Governor**:
   - Implement micro-pause batching in Anvil's process supervisor or XMRig thread loop to sustain peak clocks below the phone's thermal throttle threshold.
