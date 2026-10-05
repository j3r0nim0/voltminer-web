#!/usr/bin/env bash
# Deploy the Browser Experiment to the droplet, and refuse to leave the site in
# a state whose published hashes do not describe it.
#
#   tools/deploy.sh --dry-run     # change nothing; show what would move
#   tools/deploy.sh               # deploy
#   tools/deploy.sh --skip-caddy  # site files only, leave the Caddyfile alone
#
# What it does, in order, aborting on the first failure:
#   1. checks the ?v= deploy version is consistent everywhere
#   2. checks the published C++ mirror still matches the source it mirrors
#   3. regenerates transparency/SHA256SUMS from the served tree
#   4. stages exactly the served tree and pushes it with --delete
#   5. verifies the hashes against the files on the server
#   6. validates and reloads the Caddy config, only if it changed
#
# Steps 1, 2 and 5 exist because all three have already gone wrong by hand in
# this project: a stale ?v= on one script, a hand-synced duplicate, and a deploy
# nobody checked. Env overrides: HOST, WEB_ROOT, SSH_KEY, STAGE.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
HOST=${HOST:-root@137.184.209.157}
WEB_ROOT=${WEB_ROOT:-/var/www/voltminer-web}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
STAGE=${STAGE:-${TMPDIR:-/tmp}/voltminer-web-stage}
CADDY_LOCAL=tools/server/Caddyfile
CADDY_REMOTE=/etc/caddy/Caddyfile

DRY=0
SKIP_CADDY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    --skip-caddy) SKIP_CADDY=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mABORT\033[0m %s\n' "$*" >&2; exit 1; }

# A deploy script that can die without saying why is worse than no script: you
# are left not knowing whether the site is half-pushed. (This trap exists
# because exactly that happened once, at the hash check.)
trap 'printf "\n\033[31mABORT\033[0m unexpected failure at %s line %s — the site may be partially deployed; read the output above\n" "$0" "$LINENO" >&2' ERR

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
run_remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

[ -f "$SSH_KEY" ] || die "ssh key not found: $SSH_KEY"
[ -f "$CADDY_LOCAL" ] || die "caddy config not found: $CADDY_LOCAL"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"

# ── 1. the ?v= deploy version is the cache-busting contract ─────────────────
# One stale ?v= on one script ships a mixed build: today's page loading an
# earlier deploy's miner-client.js. Cheap to check, invisible to find later.
say "1. deploy version"
VER_FILES=$(tools/served-tree.sh | grep -E '\.(html|js)$' | grep -v '^js/vendor/' || true)
VERSIONS=$(printf '%s\n' "$VER_FILES" | xargs grep -hoE '\?v=[0-9]+' 2>/dev/null | sed 's/?v=//' | sort -u | tr '\n' ' ' || true)
VER_COUNT=$(printf '%s' "$VERSIONS" | wc -w | tr -d ' ')
[ "$VER_COUNT" -eq 1 ] || die "?v= must be one value, found: ${VERSIONS:-none}. Which file is stale:
$(printf '%s\n' "$VER_FILES" | xargs grep -HoE '\?v=[0-9]+' 2>/dev/null | sed 's/^/    /')"
VER=$(printf '%s' "$VERSIONS" | tr -d ' ')
SW_VER=$(grep -oE "const VERSION = '[0-9]+'" sw.js | grep -oE '[0-9]+' || true)
[ "$SW_VER" = "$VER" ] || die "sw.js VERSION ($SW_VER) != script ?v= ($VER). The worker would not see its own update, and the offline shell would re-precache under the old name."
ok "?v=$VER everywhere, matches sw.js VERSION"

# Untracked files get published too (otherwise a brand-new file 404s while the
# page that references it ships). Say so out loud rather than quietly shipping
# whatever is lying around the worktree.
UNTRACKED=$(tools/served-tree.sh | while IFS= read -r f; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || printf '%s\n' "$f"
done)
if [ -n "$UNTRACKED" ]; then
  warn "untracked, will be published: $(printf '%s' "$UNTRACKED" | tr '\n' ' ')"
fi

# ── 2. the published C++ mirror is a copy, and copies drift ─────────────────
say "2. published wasm patch mirrors its source"
if diff -rq --exclude=README.md third_party/WebRandomX-overlay transparency/wasm-patch >/dev/null 2>&1; then
  ok "transparency/wasm-patch == third_party/WebRandomX-overlay"
else
  die "the published C++ no longer matches the source it mirrors. Resync it:
  rsync -a --delete --exclude=README.md third_party/WebRandomX-overlay/ transparency/wasm-patch/
  then re-run this script. (Publishing code that is not the code you compiled is the one thing transparency/ must never do.)"
fi

# ── 3. hashes describe exactly what step 4 will push ────────────────────────
say "3. regenerate published hashes"
tools/gen-sha256sums.sh
ok "$(wc -l < transparency/SHA256SUMS | tr -d ' ') files hashed"

# ── 4. stage and push ───────────────────────────────────────────────────────
say "4. stage and push"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tools/served-tree.sh > "$STAGE/.files-from"
rsync -a --files-from="$STAGE/.files-from" ./ "$STAGE/"
rm -f "$STAGE/.files-from"
STAGED=$(find "$STAGE" -type f | wc -l | tr -d ' ')
ok "staged $STAGED files in $STAGE"

if [ "$DRY" = 1 ]; then
  warn "dry run: no changes pushed"
  rsync -a --delete --dry-run --itemize-changes -e "$RSYNC_SSH" "$STAGE/" "$HOST:$WEB_ROOT/" \
    | grep -vE '^$' | sed 's/^/    /' || true
  exit 0
fi

# Insurance, because verification happens after the push: keep the previous
# tree so "put it back" is a command and not a reconstruction.
BACKUP="/root/voltminer-web-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
run_remote "tar czf '$BACKUP' -C '$WEB_ROOT' . && chmod 600 '$BACKUP'" || die "could not back up $WEB_ROOT"
run_remote "ls -1t /root/voltminer-web-backup-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f"
ok "server backup: $BACKUP (keeping the 5 most recent)"
warn "restore with: ssh $HOST 'rm -rf $WEB_ROOT/* && tar xzf $BACKUP -C $WEB_ROOT && chown -R www-data:www-data $WEB_ROOT'"

rsync -a --delete --itemize-changes -e "$RSYNC_SSH" "$STAGE/" "$HOST:$WEB_ROOT/" \
  | grep -vE '^\.d' | sed 's/^/    /' || true
run_remote "chown -R www-data:www-data '$WEB_ROOT'"
ok "pushed"

# ── 5. verify the bytes on the server against the published list ────────────
say "5. verify hashes on the server"
run_remote "cd '$WEB_ROOT' && sha256sum -c transparency/SHA256SUMS" 2>&1 | grep -v ': OK$' | sed 's/^/    /' || true
# `|| true` inside the remote command, not outside it: grep -c exits 1 when it
# finds nothing, and a failing command substitution takes the whole script down
# under set -e — the check for "0 failures" must not itself look like a failure.
FAILED=$(run_remote "cd '$WEB_ROOT' && sha256sum -c transparency/SHA256SUMS 2>&1 | grep -c -v ': OK$' || true" | tr -d ' ')
PASSED=$(run_remote "cd '$WEB_ROOT' && sha256sum -c transparency/SHA256SUMS 2>&1 | grep -c ': OK$' || true" | tr -d ' ')
[ "$FAILED" = 0 ] || die "$FAILED file(s) on the server do not match the published hashes. Roll back with the command printed above, or investigate before trusting this deploy."
[ "$PASSED" = "$(wc -l < transparency/SHA256SUMS | tr -d ' ')" ] || die "verified $PASSED hashes but published $(wc -l < transparency/SHA256SUMS | tr -d ' ')."
ok "$PASSED/$PASSED hashes match"

# ── 6. Caddy, only if it changed ────────────────────────────────────────────
if [ "$SKIP_CADDY" = 1 ]; then
  warn "caddy config skipped (--skip-caddy)"
else
  say "6. caddy config"
  scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$CADDY_LOCAL" "$HOST:/tmp/Caddyfile.new"
  if run_remote "cmp -s /tmp/Caddyfile.new '$CADDY_REMOTE'"; then
    ok "unchanged, not reloaded"
  else
    run_remote "set -e
      caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/tmp/caddy-validate.log 2>&1 || { echo VALIDATE_FAILED; cat /tmp/caddy-validate.log; exit 1; }
      cp '$CADDY_REMOTE' '$CADDY_REMOTE.bak'
      cp /tmp/Caddyfile.new '$CADDY_REMOTE'
      systemctl reload caddy" || die "caddy rejected the new config; the live one is untouched apart from $CADDY_REMOTE.bak"
    ok "validated and reloaded"
  fi
fi

say "deployed"
printf '  version   ?v=%s\n  files     %s pushed, %s hashed and verified\n  url       https://web.voltminer.net/\n' \
  "$VER" "$STAGED" "$PASSED"
printf '  reminder  commit transparency/SHA256SUMS\n'
printf '  note      installed devices pick this up on next open; the worker update shows a Reload banner\n'
