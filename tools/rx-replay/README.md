# Offline RandomX replay

Does not mine. Fetches one gulf job, hashes `job.blob` with native tevador RandomX and with `web-randomx.wasm`.

```bash
python3 fetch_job.py          # writes /tmp/rx-local-test/job.json if you keep that path
# or point hash_blob / hash_wasm.mjs at a saved job.json
```

See `hash_blob.cpp` (link against tevador `librandomx.a`) and `hash_wasm.mjs`.
`mine_vs_hash.mjs` compares `_randomx_hash` vs `_randomx_mine` on the same blob.

Browser tests (`rx-test.html`, `rx-mine-vs-hash.html`) expect to be served next to `js/vendor/randomx/` (or edit the WASM_JS URL).
