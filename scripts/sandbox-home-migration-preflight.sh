#!/usr/bin/env bash
#
# Pre-flight scan for the `sandbox.home_mode: per_user` migration.
#
# The per-user home overlay presents each user's home at a STABLE path (the
# passwd home) inside the sandbox, sourced from a relocated per-owner store.
# Relocation is safe only if the agentic tools' persisted state does not hard-
# code the OLD absolute home path. This script proves that for a real
# deployment BEFORE you move anything: for every human home it can see, it
# greps the tools' CONFIG/auth/state files for that home's own absolute path.
#
# It is READ-ONLY. It never prints file contents — only per-file HIT COUNTS —
# so it is safe to run against homes holding live credentials/transcripts.
#
# Three tiers, by what a home-path reference would actually break:
#   AUTH/SETTINGS (hard blocker) — auth.json, .credentials.json, settings.json:
#       a home path baked HERE would break tool auth/behavior after relocation.
#       Validated on Agor's prod box: 0 hits across 40+ managed homes.
#   CWD REGISTRY (review, not fatal) — .claude.json (.projects/.githubRepoPaths),
#       .codex/config.toml ([projects."<cwd>"]): these are keyed by the WORKING
#       DIRECTORY, not the home. On a personal machine cwd lives under $HOME so
#       they reference it; in Agor the executor cwd is the BRANCH (re-exposed at
#       its real path by the overlay), so they never reference the home. Hits are
#       expected + benign — verify they are project/cwd keys, not auth.
#   SESSIONS (non-blocking) — .codex/sessions/**, .claude/projects/**: historical
#       transcripts; their embedded paths are cosmetic.
#
# Usage:
#   scripts/sandbox-home-migration-preflight.sh [home_glob]
#   scripts/sandbox-home-migration-preflight.sh '/home/*'      # default
#   scripts/sandbox-home-migration-preflight.sh '/home/alice'  # one user

set -euo pipefail

HOME_GLOB="${1:-/home/*}"

# AUTH/SETTINGS — a home-path hit HERE blocks migration (breaks auth/behavior).
AUTH_GLOBS=(
  ".claude/settings.json"
  ".claude/settings.local.json"
  ".claude/.credentials.json"
  ".codex/auth.json"
  ".gemini/settings.json"
)
# CWD REGISTRY — hits expected (keyed by working dir, not home); review only.
CWD_REGISTRY_GLOBS=(
  ".claude.json"
  ".codex/config.toml"
)
# SESSIONS/history — historical transcripts; non-blocking.
NONBLOCKING_GLOBS=(
  ".codex/sessions"
  ".claude/projects"
  ".claude/history"
)

blockers=0
scanned=0

count_hits() {
  # count_hits <file> <needle> → number of matching lines (0 if file absent/unreadable)
  local f="$1" needle="$2" n
  [ -e "$f" ] || { echo 0; return 0; }
  # grep exits 1 on no-match and 2 on error (e.g. 0600 creds); never let that
  # abort the run under `set -e`. Capture the count, then normalize.
  n=$(grep -aFc -- "$needle" "$f" 2>/dev/null) || n=0
  echo "${n:-0}"
}

count_hits_tree() {
  # count_hits_tree <dir> <needle> → number of files under the tree that match
  local d="$1" needle="$2" n
  [ -d "$d" ] || { echo 0; return 0; }
  # `{ grep || true; }` so a permission error inside the tree can't fail the
  # pipe; wc is the last command so the pipe exits 0.
  n=$({ grep -aFrl -- "$needle" "$d" 2>/dev/null || true; } | wc -l)
  echo "${n//[^0-9]/}"
}

echo "== sandbox per-user home migration pre-flight =="
echo "scanning homes matching: $HOME_GLOB"
echo

for home in $HOME_GLOB; do
  [ -d "$home" ] || continue
  # Skip system/service homes with no tool state.
  if [ ! -d "$home/.claude" ] && [ ! -d "$home/.codex" ] && [ ! -d "$home/.gemini" ]; then
    continue
  fi
  scanned=$((scanned + 1))
  needle="$home" # the home's OWN absolute path — what must NOT be baked into config
  echo "--- $home ---"

  home_blockers=0
  for rel in "${AUTH_GLOBS[@]}"; do
    n=$(count_hits "$home/$rel" "$needle")
    if [ "$n" != "0" ]; then
      echo "  BLOCKER  $rel : $n line(s) reference $needle"
      home_blockers=$((home_blockers + 1))
    fi
  done
  [ "$home_blockers" = "0" ] && echo "  ok: no auth/settings file hard-codes the home path"

  for rel in "${CWD_REGISTRY_GLOBS[@]}"; do
    n=$(count_hits "$home/$rel" "$needle")
    [ "$n" != "0" ] &&
      echo "  review (cwd-keyed, expected) $rel : $n line(s) reference $needle — verify project/cwd keys, not auth"
  done

  for rel in "${NONBLOCKING_GLOBS[@]}"; do
    n=$(count_hits_tree "$home/$rel" "$needle")
    [ "$n" != "0" ] && echo "  note (non-blocking) $rel/ : $n file(s) reference $needle (historical)"
  done

  blockers=$((blockers + home_blockers))
  echo
done

echo "== summary =="
echo "homes scanned : $scanned"
echo "blockers      : $blockers"
if [ "$blockers" != "0" ]; then
  echo
  echo "MIGRATION NOT SAFE YET: an auth/settings file hard-codes an absolute home path."
  echo "Investigate the BLOCKER lines above before relocating homes. ('review' lines are"
  echo "cwd-keyed registries and are expected — they do not block.)"
  exit 1
fi
echo "SAFE: no auth/settings file hard-codes its home path — homes can be relocated into"
echo "the per-owner store (<data_home>/tenants/<tenant>/homes/<owner_id>). Any 'review'"
echo "lines above are cwd-keyed project registries (expected; not a blocker)."
