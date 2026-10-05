#!/usr/bin/env bash
# Single source of truth for "what the site serves".
#
# tools/gen-sha256sums.sh and tools/deploy.sh both read this instead of each
# keeping their own hand-written list. Before this, they would have disagreed
# the moment someone added a file — and a published-hash list that is missing a
# file is worse than none, because the page still says "verify our hashes" while
# the file you care about is not in it. Silent, and no error to notice.
#
# Derived from git: tracked files plus untracked-but-not-ignored ones, so a new
# file is included the moment it exists and an ignored one never is.
set -euo pipefail
cd "$(dirname "$0")/.."

git ls-files --cached --others --exclude-standard | while IFS= read -r f; do
  case "$f" in
    # Repo documentation. Useful to a human, pointless to a miner.
    README.md) continue ;;
    # Dev material. The relay source that matters is published under
    # transparency/relay/, and the C++ under transparency/wasm-patch/.
    tools/*|third_party/*) continue ;;
    # Served, and they contain a dot: the .well-known directory is part of the
    # security.txt convention, and .nojekyll is kept for the Pages fallback host.
    .well-known/*|.nojekyll) printf '%s\n' "$f" ;;
    # Any other dotfile (.gitignore, .gitkeep) is build noise, not content.
    */.*|.*) continue ;;
    *) printf '%s\n' "$f" ;;
  esac
done | sort
