/* Hash one Monero stratum blob with native tevador RandomX (interpreted + full mem). */
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <vector>
#include <string>

#include "randomx.h"

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static std::vector<uint8_t> from_hex(const char *s) {
  std::vector<uint8_t> out;
  size_t n = strlen(s);
  if (n % 2) return out;
  out.resize(n / 2);
  for (size_t i = 0; i < out.size(); i++) {
    int a = hex_nibble(s[2 * i]);
    int b = hex_nibble(s[2 * i + 1]);
    if (a < 0 || b < 0) { out.clear(); return out; }
    out[i] = (uint8_t)((a << 4) | b);
  }
  return out;
}

static void to_hex(const uint8_t *p, size_t n, char *out) {
  static const char *H = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = H[p[i] >> 4];
    out[2 * i + 1] = H[p[i] & 0xf];
  }
  out[2 * n] = 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <seed_hex> <blob_hex> [nonce_hex_le]\n", argv[0]);
    return 2;
  }
  auto seed = from_hex(argv[1]);
  auto blob = from_hex(argv[2]);
  if (seed.size() != 32 || blob.size() < 43) {
    fprintf(stderr, "bad seed (%zu) or blob (%zu)\n", seed.size(), blob.size());
    return 2;
  }
  if (argc >= 4) {
    auto nonce = from_hex(argv[3]);
    if (nonce.size() != 4) {
      fprintf(stderr, "nonce must be 4 bytes hex\n");
      return 2;
    }
    memcpy(blob.data() + 39, nonce.data(), 4);
  }

  randomx_flags flags = RANDOMX_FLAG_DEFAULT;
  randomx_cache *cache = randomx_alloc_cache(flags);
  if (!cache) {
    fprintf(stderr, "alloc_cache failed\n");
    return 1;
  }
  randomx_init_cache(cache, seed.data(), seed.size());
  randomx_vm *vm = randomx_create_vm(flags, cache, nullptr);
  if (!vm) {
    fprintf(stderr, "create_vm failed\n");
    return 1;
  }
  uint8_t hash[RANDOMX_HASH_SIZE];
  randomx_calculate_hash(vm, blob.data(), blob.size(), hash);
  char hex[65];
  to_hex(hash, 32, hex);
  printf("%s\n", hex);
  char noncehex[9];
  to_hex(blob.data() + 39, 4, noncehex);
  fprintf(stderr, "blob_len=%zu nonce=%s light=1\n", blob.size(), noncehex);

  randomx_destroy_vm(vm);
  randomx_release_cache(cache);
  return 0;
}
