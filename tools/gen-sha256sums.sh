#!/usr/bin/env bash
# Regenerate transparency/SHA256SUMS for every file the site serves.
#
#   tools/gen-sha256sums.sh
#   sha256sum -c transparency/SHA256SUMS     # from the repo root, or on the server
#
# The file list comes from tools/served-tree.sh, which is also what the deploy
# reads — so the hashes cannot describe a different set of files than the one
# that gets pushed. Run this before committing; tools/deploy.sh runs it for you.
#
# Deterministic order, so a diff shows exactly what changed in a deploy.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=transparency/SHA256SUMS
HERE="$(dirname "$0")"

# A file cannot contain its own hash, so the sums file is deployed but never
# listed. Everything else in the served tree is fair game, including pages and
# images that were never covered by the hand-written version of this list.
tools/served-tree.sh | grep -v '^transparency/SHA256SUMS$' | while IFS= read -r f; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done > "$OUT"

printf 'wrote %s (%s files)\n' "$OUT" "$(wc -l < "$OUT" | tr -d ' ')"
