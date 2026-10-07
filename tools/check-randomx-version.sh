#!/bin/sh
# Watch for Monero moving to RandomX v2.
#
# Why this exists: rx/0 v1 (program size 256) is what the Monero network
# verifies today. RandomX v2 (program size 384) is a DIFFERENT function — same
# seed, different hash — so a v2 build has every share rejected by the pool
# while the miner still reports a healthy hashrate. There is no v2 hard fork
# scheduled as of 2026-10-07; this script is the tripwire for when that changes.
#
# Signals, cheapest first:
#   1. Monero's external/randomx submodule sha     - moves BEFORE a fork is scheduled
#   2. Is that sha still on tevador/RandomX v1.x?  - v2 lives on master
#   3. Highest version in mainnet_hard_forks[]     - the authoritative "it is happening"
#
# Exit 0 = still on the v1 line. Exit 1 = something moved; re-read the output.
set -u
API=https://api.github.com
CURL="curl -sSL --max-time 25"
[ -n "${GH_TOKEN:-}" ] && AUTH="-H 'Authorization: Bearer $GH_TOKEN'" || AUTH=""

json() { $CURL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} "$1"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$2" 2>/dev/null; }

alert=0

sub=$(json "$API/repos/monero-project/monero/contents/external/randomx" | field - "d.get('sha','?')")
printf 'Monero external/randomx : %s\n' "$sub"
info=$(json "$API/repos/tevador/RandomX/commits/$sub" |
  field - "'%s  %s' % (d['commit']['committer']['date'][:10], d['commit']['message'].split(chr(10))[0])")
printf '  pinned commit         : %s\n' "$info"

v1x=$(json "$API/repos/tevador/RandomX/branches/v1.x" | field - "d['commit']['sha']")
printf 'tevador/RandomX v1.x    : %s\n' "$v1x"

# If the pinned commit is an ancestor of (or equal to) v1.x, Monero is on the v1
# line. "ahead"/"diverged" means it has left it.
st=$(json "$API/repos/tevador/RandomX/compare/$v1x...$sub" | field - "d.get('status','?')")
case "$st" in
  behind|identical) printf '  status                : %s  (still on the v1 line)\n' "$st" ;;
  *)                 printf '  status                : %s  <-- OFF THE v1 LINE\n' "$st"; alert=1 ;;
esac

hf=$($CURL https://raw.githubusercontent.com/monero-project/monero/master/src/hardforks/hardforks.cpp |
  sed -n '/mainnet_hard_forks\[\]/,/^};/p' | grep -oE '^\s*\{ [0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
printf 'highest scheduled fork  : v%s  (v16 = 2022-07)\n' "${hf:-?}"
[ "${hf:-0}" -gt 16 ] 2>/dev/null && { printf '  <-- a fork beyond v16 is scheduled\n'; alert=1; }

echo
if [ "$alert" -eq 0 ]; then
  echo "OK: Monero is still on RandomX v1 and no v2 fork is scheduled."
  echo "Nothing to do. Re-run after Monero's next release announcement."
else
  echo "CHANGED: re-check before shipping anything to do with the wasm engine."
  echo "  1. Re-run diag.html - the reference vector must still MATCH."
  echo "  2. Confirm the build still selects v1 (shim strips RANDOMX_FLAG_V2)."
  echo "  3. Watch a live share get accepted by the pool before trusting a soak."
fi
exit "$alert"
