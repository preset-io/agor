#!/usr/bin/env bash
#
# Pre-flight scan for the `sandbox.home_mode: per_user` migration.
#
# The per-user home overlay presents each user's home at a STABLE path (the
# passwd home) inside the sandbox, sourced from a relocated per-owner store.
# Relocation is safe only if the agentic tools' persisted state does not hard-
# code the OLD absolute home path. This script proves that for a real
# deployment BEFORE changing ownership: for every human home it can see, it
# greps the tools' CONFIG/auth/state files for both the passwd path and its
# canonical target. Either alias becomes hidden when the home is overlaid.
#
# It is READ-ONLY. It never prints file contents — only per-file HIT COUNTS —
# so it is safe to run against homes holding live credentials/transcripts.
#
# Three tiers, by what a home-path reference would actually break:
#   AUTH/SETTINGS (hard blocker) — auth.json, .credentials.json, settings.json:
#       a home path baked HERE would break tool auth/behavior after relocation.
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
#   scripts/sandbox-home-migration-preflight.sh [home_glob] [--stable-home DIR]
#   scripts/sandbox-home-migration-preflight.sh '/home/*' --stable-home /home/agor
#
# `--stable-home` identifies the daemon passwd home used as the sandbox mount
# target, not a migrated owner store. References found anywhere in that home
# (including through its canonical alias) are reported for review instead of
# counted as blockers.

set -euo pipefail

HOME_GLOB="/home/*"
STABLE_HOME=""
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
  HOME_GLOB="$1"
  shift
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --stable-home)
      [ $# -ge 2 ] || { echo "--stable-home requires a directory" >&2; exit 2; }
      STABLE_HOME="$2"
      shift 2
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

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
  # count_hits <file> <needle> → number of matching lines (0 if file absent)
  local f="$1" needle="$2" n status
  [ -e "$f" ] || { echo 0; return 0; }
  set +e
  n=$(grep -aFc -- "$needle" "$f")
  status=$?
  set -e
  case "$status" in
    0) echo "${n:-0}" ;;
    1) echo 0 ;;
    *) echo "ERROR: could not scan $f" >&2; return "$status" ;;
  esac
}

count_hits_tree() {
  # count_hits_tree <dir> <needle> → number of files under the tree that match
  local d="$1" needle="$2" matches status
  [ -d "$d" ] || { echo 0; return 0; }
  set +e
  matches=$(grep -aFrl -- "$needle" "$d")
  status=$?
  set -e
  case "$status" in
    0) printf '%s\n' "$matches" | wc -l ;;
    1) echo 0 ;;
    *) echo "ERROR: could not scan $d" >&2; return "$status" ;;
  esac
}

echo "== sandbox per-user home migration pre-flight =="
echo "scanning homes matching: $HOME_GLOB"
echo

mapfile -t HOMES < <(compgen -G "$HOME_GLOB" || true)
for home in "${HOMES[@]}"; do
  [ -d "$home" ] || continue
  # Skip system/service homes with no tool state.
  if [ ! -d "$home/.claude" ] && [ ! -d "$home/.codex" ] && [ ! -d "$home/.gemini" ]; then
    continue
  fi
  scanned=$((scanned + 1))
  echo "--- $home ---"

  home_blockers=0
  canonical_home="$(readlink -f "$home")"
  needles=("$home")
  [ "$canonical_home" = "$home" ] || needles+=("$canonical_home")
  for needle in "${needles[@]}"; do
    for rel in "${AUTH_GLOBS[@]}"; do
      n=$(count_hits "$home/$rel" "$needle")
      if [ "$n" != "0" ]; then
        if [ -n "$STABLE_HOME" ] && [ "$home" = "$STABLE_HOME" ]; then
          echo "  review (stable daemon home) $rel : $n line(s) reference $needle"
        else
          echo "  BLOCKER  $rel : $n line(s) reference $needle"
          home_blockers=$((home_blockers + 1))
        fi
      fi
    done

    for rel in "${CWD_REGISTRY_GLOBS[@]}"; do
      n=$(count_hits "$home/$rel" "$needle")
      [ "$n" != "0" ] &&
        echo "  review (cwd-keyed, expected) $rel : $n line(s) reference $needle — verify project/cwd keys, not auth"
    done

    for rel in "${NONBLOCKING_GLOBS[@]}"; do
      n=$(count_hits_tree "$home/$rel" "$needle")
      [ "$n" != "0" ] && echo "  note (non-blocking) $rel/ : $n file(s) reference $needle (historical)"
    done
  done
  [ "$home_blockers" = "0" ] && echo "  ok: no auth/settings file hard-codes a hidden home path"

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
echo "SAFE: no auth/settings file hard-codes a home path that changes under the overlay."
echo "Any 'review' lines above are stable-target references or cwd-keyed registries."
