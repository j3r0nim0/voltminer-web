#!/usr/bin/env bash
# Regenerate transparency/SHA256SUMS for every file the site actually serves.
#
# Run from the repo root, then verify against the live host:
#   tools/gen-sha256sums.sh
#   sha256sum -c transparency/SHA256SUMS
#
# Scope: the served tree below, minus tools/ and third_party/ (dev material —
# the build recipe and the wasm patch are published under transparency/ anyway).
# Deterministic order, so a diff shows exactly what changed in a deploy.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=transparency/SHA256SUMS

{
  # Pages
  printf '%s\n' index.html diag.html notices.html
  # Installability
  printf '%s\n' manifest.webmanifest sw.js
  # Styles and icons
  printf '%s\n' css/styles.css
  ls icons/*.png 2>/dev/null || true
  # Site scripts, unminified
  ls js/*.js 2>/dev/null || true
  # The wasm binaries themselves (the glue .js sits next to them, unminified)
  ls js/vendor/randomx/*.js js/vendor/randomx/*.wasm 2>/dev/null || true
  # Published audit material
  ls transparency/index.html transparency/verify.md 2>/dev/null || true
  ls transparency/relay/*.mjs 2>/dev/null || true
  ls transparency/wasm-patch/*.sh transparency/wasm-patch/*.patch 2>/dev/null || true
  ls transparency/wasm-patch/src/cpp/*.cpp transparency/wasm-patch/src/cpp/*.hpp 2>/dev/null || true
} | sort -u | while read -r f; do
  [ -f "$f" ] || continue
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') files)"
