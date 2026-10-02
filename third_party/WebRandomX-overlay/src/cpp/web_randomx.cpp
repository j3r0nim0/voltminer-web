#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <limits.h>

#include "randomx.h"
#include "web_randomx.h"

#if defined(__EMSCRIPTEN_PTHREADS__)
#include <pthread.h>
#endif

#define HASH_SIZE 32
#define NONCE_OFFSET 39
#define MAX_THREADS 8

typedef struct rx_state {
  char rs_hash[HASH_SIZE];
  uint64_t rs_height;
  randomx_cache *rs_cache;
} rx_state;

static rx_state rx_s[2] = {{{0}, 0, 0}, {{0}, 0, 0}};
static randomx_vm *rx_vms[MAX_THREADS];
static int rx_vm_count = 0;
static int rx_full_mem = 0;
static int rx_threads = 1;

static randomx_dataset *rx_dataset = NULL;
static randomx_cache *rx_ds_cache = NULL;
static unsigned long rx_ds_next = 0;
static unsigned long rx_ds_total = 0;
static int rx_ds_ready = 0;
static unsigned char rx_ds_seed[HASH_SIZE];
static int rx_ds_seed_set = 0;

#if defined(__EMSCRIPTEN_PTHREADS__)
static pthread_mutex_t rx_mu = PTHREAD_MUTEX_INITIALIZER;
#endif

static inline void rx_lock(void) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  pthread_mutex_lock(&rx_mu);
#endif
}

static inline void rx_unlock(void) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  pthread_mutex_unlock(&rx_mu);
#endif
}

static inline int disabled_flags(void) {
  static int flags = -1;
  if (flags != -1) return flags;
  const char *env = getenv("MONERO_RANDOMX_UMASK");
  if (!env) { flags = 0; return flags; }
  char *endptr;
  long int value = strtol(env, &endptr, 0);
  flags = (endptr != env && value >= 0 && value < INT_MAX) ? (int)value : 0;
  return flags;
}

static inline int enabled_flags(void) {
  static int flags = -1;
  if (flags != -1) return flags;
  flags = randomx_get_flags();
  return flags;
}

#define SEEDHASH_EPOCH_BLOCKS 2048
#define SEEDHASH_EPOCH_LAG 64

uint64_t rx_seedheight(const uint64_t height) {
  return (height <= SEEDHASH_EPOCH_BLOCKS + SEEDHASH_EPOCH_LAG)
    ? 0
    : (height - SEEDHASH_EPOCH_LAG - 1) & ~(SEEDHASH_EPOCH_BLOCKS - 1);
}

/* XMRig stores nonce as little-endian uint32_t at blob[39] and hex-encodes
   those four bytes on submit. Match that so gulf reconstructs the same blob. */
static void write_nonce(uint8_t *blob, uint32_t nonce) {
  blob[NONCE_OFFSET]     = (uint8_t)(nonce & 0xff);
  blob[NONCE_OFFSET + 1] = (uint8_t)((nonce >> 8) & 0xff);
  blob[NONCE_OFFSET + 2] = (uint8_t)((nonce >> 16) & 0xff);
  blob[NONCE_OFFSET + 3] = (uint8_t)((nonce >> 24) & 0xff);
}

static uint64_t load_le64(const uint8_t *p) {
  return (uint64_t)p[0]
    | ((uint64_t)p[1] << 8)
    | ((uint64_t)p[2] << 16)
    | ((uint64_t)p[3] << 24)
    | ((uint64_t)p[4] << 32)
    | ((uint64_t)p[5] << 40)
    | ((uint64_t)p[6] << 48)
    | ((uint64_t)p[7] << 56);
}

/* MO: hashDiff = (2^256-1) / le256(hash); accept iff hashDiff >= job.difficulty.
   4-byte stratum target encodes difficulty as 0xFFFFFFFF / tmp. */
static int meets_target(const uint8_t *hash, const uint8_t *target, size_t target_len) {
  if (target_len < 4) return 0;
  uint64_t diff;
  if (target_len >= 8) {
    uint64_t t64 = load_le64(target);
    if (t64 == 0) return 0;
    diff = 0xFFFFFFFFFFFFFFFFULL / t64;
  } else {
    uint32_t tmp = (uint32_t)target[0]
      | ((uint32_t)target[1] << 8)
      | ((uint32_t)target[2] << 16)
      | ((uint32_t)target[3] << 24);
    if (tmp == 0) return 0;
    diff = 0xFFFFFFFFULL / (uint64_t)tmp;
  }
  if (diff == 0) return 0;
  /* hash * difficulty  as 40-byte little-endian; accept if product < 2^256
     (i.e. bytes 32.. are zero). Same test as gulf hashBuffDiff >= job.difficulty. */
  uint32_t prod[40];
  memset(prod, 0, sizeof(prod));
  for (int i = 0; i < 32; i++) {
    uint32_t carry = 0;
    uint32_t h = hash[i];
    for (int j = 0; j < 8; j++) {
      uint32_t db = (uint32_t)((diff >> (8 * j)) & 0xff);
      uint32_t v = prod[i + j] + h * db + carry;
      prod[i + j] = v & 0xff;
      carry = v >> 8;
    }
    int k = i + 8;
    while (carry && k < 40) {
      uint32_t v = prod[k] + carry;
      prod[k] = v & 0xff;
      carry = v >> 8;
      k++;
    }
  }
  for (int i = 32; i < 40; i++) if (prod[i]) return 0;
  return 1;
}

static randomx_flags light_flags(void) {
  randomx_flags flags = randomx_flags(enabled_flags() & ~disabled_flags());
  flags = randomx_flags(flags & ~RANDOMX_FLAG_LARGE_PAGES);
  flags = randomx_flags(flags & ~RANDOMX_FLAG_FULL_MEM);
  return flags;
}

static randomx_flags full_flags(void) {
  randomx_flags flags = light_flags();
  flags = randomx_flags(flags | RANDOMX_FLAG_FULL_MEM);
  return flags;
}

static void destroy_all_vms(void) {
  for (int i = 0; i < MAX_THREADS; i++) {
    if (rx_vms[i]) {
      randomx_destroy_vm(rx_vms[i]);
      rx_vms[i] = NULL;
    }
  }
  rx_vm_count = 0;
}

static randomx_cache *cache_for(const uint64_t mainheight, const uint64_t seedheight, const char *seedhash) {
  uint64_t s_height = rx_seedheight(mainheight);
  int toggle = (s_height & SEEDHASH_EPOCH_BLOCKS) != 0;
  if (s_height != seedheight) toggle ^= 1;
  rx_state *rx_sp = &rx_s[toggle];
  randomx_flags flags = rx_ds_ready ? full_flags() : light_flags();
  if (rx_sp->rs_cache == NULL) {
    rx_sp->rs_cache = randomx_alloc_cache(flags);
    if (rx_sp->rs_cache == NULL) {
      rx_sp->rs_cache = randomx_alloc_cache(RANDOMX_FLAG_DEFAULT);
    }
    if (rx_sp->rs_cache == NULL) return NULL;
  }
  if (rx_sp->rs_height != seedheight || memcmp(seedhash, rx_sp->rs_hash, HASH_SIZE)) {
    randomx_init_cache(rx_sp->rs_cache, seedhash, HASH_SIZE);
    rx_sp->rs_height = seedheight;
    memcpy(rx_sp->rs_hash, seedhash, HASH_SIZE);
    destroy_all_vms();
  }
  return rx_sp->rs_cache;
}

static int ensure_vms(int n, const uint64_t mainheight, const uint64_t seedheight, const char *seedhash) {
  if (n < 1) n = 1;
  if (n > MAX_THREADS) n = MAX_THREADS;
  rx_lock();
  randomx_cache *cache = cache_for(mainheight, seedheight, seedhash);
  rx_full_mem = (rx_ds_ready && rx_dataset != NULL) ? 1 : 0;
  randomx_flags flags = rx_full_mem ? full_flags() : light_flags();
  randomx_dataset *ds = rx_full_mem ? rx_dataset : NULL;
  rx_unlock();
  if (cache == NULL) return 0;

  if (rx_vm_count > n) {
    for (int i = n; i < rx_vm_count; i++) {
      if (rx_vms[i]) {
        randomx_destroy_vm(rx_vms[i]);
        rx_vms[i] = NULL;
      }
    }
    rx_vm_count = n;
  }

  for (int i = 0; i < n; i++) {
    if (rx_vms[i] == NULL) {
      rx_vms[i] = randomx_create_vm(flags, cache, ds);
      if (rx_vms[i] == NULL && ds) {
        rx_vms[i] = randomx_create_vm(light_flags(), cache, NULL);
      }
      if (rx_vms[i] == NULL) {
        rx_vms[i] = randomx_create_vm(RANDOMX_FLAG_DEFAULT, cache, NULL);
      }
      if (rx_vms[i] == NULL) return 0;
    } else {
      randomx_vm_set_cache(rx_vms[i], cache);
      if (ds) randomx_vm_set_dataset(rx_vms[i], ds);
    }
  }
  rx_vm_count = n;
  return 1;
}

static int mine_range_vm(
    randomx_vm *vm,
    const void *blob, size_t blob_len,
    uint32_t start_nonce, int max_hashes,
    const void *target, size_t target_len,
    int *found, char *nonce_out, char *hash_out) {
  if (found) *found = 0;
  if (!vm || !blob || blob_len < NONCE_OFFSET + 4 || max_hashes <= 0) return 0;

  uint8_t work[256];
  if (blob_len > sizeof(work)) return 0;
  memcpy(work, blob, blob_len);

  int computed = 0;
  uint8_t out[HASH_SIZE];

  /* One full hash per nonce. hash_first/next pipelining can pair the
     result with the previous nonce; gulf then rebuilds a different blob
     and scores Low difficulty even when local hashDiff beats jobDiff. */
  for (int i = 0; i < max_hashes; i++) {
    uint32_t nonce = start_nonce + (uint32_t)i;
    write_nonce(work, nonce);
    randomx_calculate_hash(vm, work, blob_len, out);
    computed += 1;
    if (meets_target(out, (const uint8_t *)target, target_len)) {
      if (found) *found = 1;
      if (nonce_out) {
        nonce_out[0] = (char)(nonce & 0xff);
        nonce_out[1] = (char)((nonce >> 8) & 0xff);
        nonce_out[2] = (char)((nonce >> 16) & 0xff);
        nonce_out[3] = (char)((nonce >> 24) & 0xff);
      }
      if (hash_out) memcpy(hash_out, out, HASH_SIZE);
      return computed;
    }
  }
  return computed;
}

EM_PORT_API(int) randomx_set_threads(int n) {
  if (n < 1) n = 1;
  if (n > MAX_THREADS) n = MAX_THREADS;
  rx_threads = n;
  return rx_threads;
}

EM_PORT_API(int) randomx_get_threads(void) {
  return rx_threads;
}

EM_PORT_API(int) randomx_dataset_begin(const uint64_t mainheight, const uint64_t seedheight, const char *seedhash) {
  rx_lock();
  randomx_cache *cache = cache_for(mainheight, seedheight, seedhash);
  if (cache == NULL) { rx_unlock(); return 0; }

  if (rx_ds_seed_set && memcmp(rx_ds_seed, seedhash, HASH_SIZE) == 0 && rx_ds_ready && rx_dataset) {
    rx_unlock();
    return 1;
  }

  if (rx_dataset == NULL) {
    rx_dataset = randomx_alloc_dataset(full_flags());
    if (rx_dataset == NULL) {
      rx_dataset = randomx_alloc_dataset(RANDOMX_FLAG_DEFAULT);
    }
  }
  if (rx_dataset == NULL) {
    rx_ds_ready = 0;
    rx_full_mem = 0;
    rx_unlock();
    return 0;
  }

  rx_ds_cache = cache;
  rx_ds_total = randomx_dataset_item_count();
  rx_ds_next = 0;
  rx_ds_ready = 0;
  memcpy(rx_ds_seed, seedhash, HASH_SIZE);
  rx_ds_seed_set = 1;
  destroy_all_vms();
  rx_unlock();
  return 1;
}

#if defined(__EMSCRIPTEN_PTHREADS__)
typedef struct {
  unsigned long start;
  unsigned long count;
} ds_arg;

static void *ds_fill_thread(void *p) {
  ds_arg *a = (ds_arg *)p;
  if (a->count) randomx_init_dataset(rx_dataset, rx_ds_cache, a->start, a->count);
  return NULL;
}

typedef struct {
  int id;
  int has_work;
  int done;
  const void *blob;
  size_t blob_len;
  uint32_t start_nonce;
  int max_hashes;
  const void *target;
  size_t target_len;
  int found;
  char nonce_out[4];
  char hash_out[HASH_SIZE];
  int computed;
} mine_slot;

static mine_slot mine_slots[MAX_THREADS];
static pthread_t mine_th[MAX_THREADS];
static int mine_th_live = 0;
static int mine_stop = 0;
static pthread_mutex_t mine_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t mine_cv = PTHREAD_COND_INITIALIZER;
static pthread_cond_t mine_done_cv = PTHREAD_COND_INITIALIZER;

static void *mine_loop(void *p) {
  int id = (int)(intptr_t)p;
  for (;;) {
    pthread_mutex_lock(&mine_mu);
    while (!mine_slots[id].has_work && !mine_stop) {
      pthread_cond_wait(&mine_cv, &mine_mu);
    }
    if (mine_stop) {
      pthread_mutex_unlock(&mine_mu);
      return NULL;
    }
    mine_slot work = mine_slots[id];
    mine_slots[id].has_work = 0;
    pthread_mutex_unlock(&mine_mu);

    int found = 0;
    int computed = mine_range_vm(
      rx_vms[id], work.blob, work.blob_len, work.start_nonce, work.max_hashes,
      work.target, work.target_len, &found, work.nonce_out, work.hash_out);

    pthread_mutex_lock(&mine_mu);
    mine_slots[id].computed = computed;
    mine_slots[id].found = found;
    memcpy(mine_slots[id].nonce_out, work.nonce_out, 4);
    memcpy(mine_slots[id].hash_out, work.hash_out, HASH_SIZE);
    mine_slots[id].done = 1;
    pthread_cond_signal(&mine_done_cv);
    pthread_mutex_unlock(&mine_mu);
  }
}

static int ensure_mine_threads(int n) {
  if (n < 1) n = 1;
  if (n > MAX_THREADS) n = MAX_THREADS;
  while (mine_th_live < n) {
    int id = mine_th_live;
    mine_slots[id].has_work = 0;
    mine_slots[id].done = 1;
    if (pthread_create(&mine_th[id], NULL, mine_loop, (void *)(intptr_t)id) != 0) {
      return mine_th_live;
    }
    mine_th_live++;
  }
  return mine_th_live;
}
#endif

EM_PORT_API(int) randomx_dataset_step(unsigned long n) {
  if (rx_dataset == NULL || rx_ds_total == 0 || rx_ds_cache == NULL) return -1;
  if (rx_ds_ready) return 100;
  if (n == 0) n = 262144UL;

  unsigned long remain = rx_ds_total - rx_ds_next;
  if (n > remain) n = remain;
  if (n > 0) {
#if defined(__EMSCRIPTEN_PTHREADS__)
    int t = rx_threads;
    if (t < 1) t = 1;
    if (t > MAX_THREADS) t = MAX_THREADS;
    if ((unsigned long)t > n) t = (int)n;
    if (t <= 1) {
      randomx_init_dataset(rx_dataset, rx_ds_cache, rx_ds_next, n);
    } else {
      pthread_t th[MAX_THREADS];
      ds_arg args[MAX_THREADS];
      unsigned long chunk = n / (unsigned long)t;
      unsigned long extra = n % (unsigned long)t;
      unsigned long at = rx_ds_next;
      int launched = 0;
      for (int i = 0; i < t; i++) {
        unsigned long c = chunk + (i < (int)extra ? 1UL : 0UL);
        args[i].start = at;
        args[i].count = c;
        at += c;
        if (c == 0) continue;
        if (pthread_create(&th[launched], NULL, ds_fill_thread, &args[i]) != 0) {
          ds_fill_thread(&args[i]);
        } else {
          launched++;
        }
      }
      for (int i = 0; i < launched; i++) pthread_join(th[i], NULL);
    }
#else
    randomx_init_dataset(rx_dataset, rx_ds_cache, rx_ds_next, n);
#endif
    rx_ds_next += n;
  }
  if (rx_ds_next >= rx_ds_total) {
    rx_ds_ready = 1;
    rx_full_mem = 1;
    destroy_all_vms();
    for (int i = 0; i < 2; i++) {
      if (rx_s[i].rs_cache && rx_s[i].rs_cache != rx_ds_cache) {
        randomx_release_cache(rx_s[i].rs_cache);
        rx_s[i].rs_cache = NULL;
        rx_s[i].rs_height = 0;
      }
    }
    return 100;
  }
  return (int)((rx_ds_next * 100UL) / rx_ds_total);
}

EM_PORT_API(int) randomx_dataset_percent(void) {
  if (rx_ds_ready) return 100;
  if (rx_ds_total == 0) return 0;
  return (int)((rx_ds_next * 100UL) / rx_ds_total);
}

EM_PORT_API(int) randomx_hash(const uint64_t mainheight, const uint64_t seedheight, const char *seedhash, const void *data, size_t length,
  char *hash) {
  if (!ensure_vms(1, mainheight, seedheight, seedhash) || rx_vms[0] == NULL) return 0;
  randomx_calculate_hash(rx_vms[0], data, length, hash);
  return 1;
}

EM_PORT_API(int) randomx_mine(
    const uint64_t mainheight, const uint64_t seedheight, const char *seedhash,
    const void *blob, size_t blob_len,
    uint32_t start_nonce, int max_hashes,
    const void *target, size_t target_len,
    int *found, char *nonce_out, char *hash_out) {
  if (found) *found = 0;
  int t = rx_threads;
  if (t < 1) t = 1;
  if (t > MAX_THREADS) t = MAX_THREADS;
  if (!ensure_vms(t, mainheight, seedheight, seedhash)) return 0;

#if defined(__EMSCRIPTEN_PTHREADS__)
  if (t > 1 && max_hashes >= t * 2) {
    int live = ensure_mine_threads(t);
    if (live >= t) {
      int per = max_hashes / t;
      int extra = max_hashes % t;
      uint32_t at = start_nonce;
      pthread_mutex_lock(&mine_mu);
      for (int i = 0; i < t; i++) {
        int c = per + (i < extra ? 1 : 0);
        mine_slots[i].blob = blob;
        mine_slots[i].blob_len = blob_len;
        mine_slots[i].start_nonce = at;
        mine_slots[i].max_hashes = c;
        mine_slots[i].target = target;
        mine_slots[i].target_len = target_len;
        mine_slots[i].found = 0;
        mine_slots[i].computed = 0;
        mine_slots[i].done = 0;
        mine_slots[i].has_work = (c > 0) ? 1 : 0;
        if (c <= 0) mine_slots[i].done = 1;
        at += (uint32_t)c;
      }
      pthread_cond_broadcast(&mine_cv);
      for (;;) {
        int all = 1;
        for (int i = 0; i < t; i++) {
          if (!mine_slots[i].done) all = 0;
        }
        if (all) break;
        pthread_cond_wait(&mine_done_cv, &mine_mu);
      }
      int computed = 0;
      for (int i = 0; i < t; i++) {
        computed += mine_slots[i].computed;
        if (mine_slots[i].found && found && *found == 0) {
          *found = 1;
          if (nonce_out) memcpy(nonce_out, mine_slots[i].nonce_out, 4);
          if (hash_out) memcpy(hash_out, mine_slots[i].hash_out, HASH_SIZE);
        }
      }
      pthread_mutex_unlock(&mine_mu);
      return computed;
    }
  }
#endif
  return mine_range_vm(rx_vms[0], blob, blob_len, start_nonce, max_hashes,
    target, target_len, found, nonce_out, hash_out);
}

EM_PORT_API(int) randomx_dataset_ptr(void) {
  if (rx_dataset == NULL) return 0;
  void *p = randomx_get_dataset_memory(rx_dataset);
  return (int)(uintptr_t)p;
}

EM_PORT_API(int) randomx_dataset_items(void) {
  return (int)rx_ds_total;
}

EM_PORT_API(int) randomx_dataset_item_bytes(void) {
  return 64;
}

EM_PORT_API(int) randomx_dataset_mark_ready(void) {
  if (rx_dataset == NULL || rx_ds_total == 0) return 0;
  rx_ds_next = rx_ds_total;
  rx_ds_ready = 1;
  rx_full_mem = 1;
  destroy_all_vms();
  return 1;
}

EM_PORT_API(int) randomx_is_full_mem(void) {
  return (rx_full_mem && rx_ds_ready) ? 1 : 0;
}
