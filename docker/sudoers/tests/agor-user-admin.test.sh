#!/bin/bash
# Test harness for docker/sudoers/agor-user-admin
# ==================================================
#
# Exercises the wrapper's input validators against adversarial arguments
# (flag-smuggling, path escapes, control chars, chpasswd field injection).
#
# Because the wrapper self-checks that it's running as root (the sudoers
# rule enforces that in production), this harness must be executed as
# root. In CI, run it inside a container:
#
#   docker run --rm -v "$PWD:/src" -w /src debian:bookworm-slim \
#     bash docker/sudoers/tests/agor-user-admin.test.sh
#
# Environment:
#   WRAPPER=/path/to/agor-user-admin   # override wrapper under test
#
# The harness DOES NOT actually create users / groups / files. It relies
# on the fact that the validators reject adversarial input with specific
# exit codes (64/65/66) BEFORE the wrapper invokes any real tool. Tests
# that would otherwise mutate system state are asserted via exit code
# + stderr pattern only.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${WRAPPER:-${SCRIPT_DIR}/../agor-user-admin}"

if [[ ! -x "$WRAPPER" ]]; then
  # Accept non-executable bit (git on some platforms drops +x); run via bash.
  if [[ ! -f "$WRAPPER" ]]; then
    echo "FATAL: wrapper not found at $WRAPPER" >&2
    exit 2
  fi
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "SKIP: agor-user-admin tests require root (run in a container)." >&2
  echo "      Usage: docker run --rm -v \"\$PWD:/src\" -w /src debian:bookworm-slim \\" >&2
  echo "             bash docker/sudoers/tests/agor-user-admin.test.sh" >&2
  exit 0
fi

pass=0
fail=0
failures=()

run_wrapper() {
  # Always invoke via bash so a missing +x bit in a fresh checkout isn't a
  # test blocker. Captures combined stderr+stdout and exit code.
  bash "$WRAPPER" "$@" 2>&1
}

run_wrapper_stdin() {
  # Same as run_wrapper but with stdin piped in. $1 = stdin, rest = argv.
  local stdin=$1
  shift
  printf '%s' "$stdin" | bash "$WRAPPER" "$@" 2>&1
}

# assert_exit <expected_code> <description> <cmd...>
assert_exit() {
  local expected=$1
  local desc=$2
  shift 2
  local out
  out=$("$@" || true)
  local actual=$?
  # $? above is always 0 because of "|| true" — re-run without it for code:
  # (We use a subshell to preserve semantics.)
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" -eq "$expected" ]]; then
    printf '  ok   [%d] %s\n' "$expected" "$desc"
    pass=$((pass + 1))
  else
    printf '  FAIL [exp=%d got=%d] %s\n' "$expected" "$actual" "$desc"
    printf '         output: %s\n' "$out"
    fail=$((fail + 1))
    failures+=("$desc (exp=$expected got=$actual)")
  fi
}

# assert_stderr_contains <pattern> <description> <cmd...>
assert_stderr_contains() {
  local pattern=$1
  local desc=$2
  shift 2
  local out
  out=$("$@" 2>&1 || true)
  if grep -qF "$pattern" <<<"$out"; then
    printf '  ok   [grep %q] %s\n' "$pattern" "$desc"
    pass=$((pass + 1))
  else
    printf '  FAIL [grep %q] %s\n' "$pattern" "$desc"
    printf '         output: %s\n' "$out"
    fail=$((fail + 1))
    failures+=("$desc (missing pattern: $pattern)")
  fi
}

echo "== agor-user-admin wrapper tests =="
echo "wrapper: $WRAPPER"
echo ""

# ----------------------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------------------
echo "-- dispatch --"
assert_exit 64 "no args → usage error (64)" bash "$WRAPPER"
assert_exit 64 "unknown verb → 64" bash "$WRAPPER" nuke-everything
assert_exit 64 "empty verb → 64" bash "$WRAPPER" ""

# ----------------------------------------------------------------------------
# validate_username
# ----------------------------------------------------------------------------
echo "-- validate_username --"
assert_exit 65 "reject empty username" bash "$WRAPPER" add-user ""
assert_exit 65 "reject uppercase" bash "$WRAPPER" add-user Alice
assert_exit 65 "reject leading digit" bash "$WRAPPER" add-user 1alice
assert_exit 65 "reject leading dash (flag-smuggle)" bash "$WRAPPER" add-user -rf
assert_exit 65 "reject leading double-dash (flag-smuggle)" bash "$WRAPPER" add-user --help
assert_exit 65 "reject semicolon (shell meta)" bash "$WRAPPER" add-user "alice;ls"
assert_exit 65 "reject backtick" bash "$WRAPPER" add-user 'ali`ce`'
assert_exit 65 "reject dollar (variable)" bash "$WRAPPER" add-user 'alice$PWD'
assert_exit 65 "reject space" bash "$WRAPPER" add-user "alice bob"
assert_exit 65 "reject 33-char username (too long)" bash "$WRAPPER" add-user "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert_exit 65 "reject root (system deny-list)" bash "$WRAPPER" add-user root
assert_exit 65 "reject agor daemon user" bash "$WRAPPER" add-user agor
assert_exit 65 "reject agor_executor" bash "$WRAPPER" add-user agor_executor

# delete-user share the same validator
assert_exit 65 "delete-user rejects root" bash "$WRAPPER" delete-user root
assert_exit 65 "delete-user --remove-home rejects root" bash "$WRAPPER" delete-user --remove-home root
assert_exit 64 "delete-user extra arg → 64" bash "$WRAPPER" delete-user alice bob

# lock/unlock
assert_exit 65 "lock-user rejects root" bash "$WRAPPER" lock-user root
assert_exit 65 "unlock-user rejects root" bash "$WRAPPER" unlock-user root

# ----------------------------------------------------------------------------
# validate_groupname
# ----------------------------------------------------------------------------
echo "-- validate_groupname --"
assert_exit 65 "reject empty group" bash "$WRAPPER" add-group ""
assert_exit 65 "add-group rejects root group" bash "$WRAPPER" add-group root
assert_exit 65 "add-group rejects sudo group" bash "$WRAPPER" add-group sudo
assert_exit 65 "add-group rejects wheel group" bash "$WRAPPER" add-group wheel
assert_exit 65 "add-group rejects agor group" bash "$WRAPPER" add-group agor
assert_exit 65 "add-group rejects flag-shaped name" bash "$WRAPPER" add-group -rf
assert_exit 65 "delete-group rejects root group" bash "$WRAPPER" delete-group root
assert_exit 64 "add-to-group needs two args" bash "$WRAPPER" add-to-group alice
assert_exit 65 "add-to-group rejects root as user" bash "$WRAPPER" add-to-group root developers
assert_exit 65 "add-to-group rejects sudo as group" bash "$WRAPPER" add-to-group alice sudo
assert_exit 65 "remove-from-group rejects root" bash "$WRAPPER" remove-from-group root developers
assert_exit 65 "remove-from-group rejects wheel" bash "$WRAPPER" remove-from-group alice wheel

# ----------------------------------------------------------------------------
# validate_path (setgid-tree + symlink verbs)
# ----------------------------------------------------------------------------
echo "-- validate_path --"
assert_exit 65 "setgid-tree rejects relative path" bash "$WRAPPER" setgid-tree "relative/path"
assert_exit 65 "setgid-tree rejects /etc" bash "$WRAPPER" setgid-tree /etc
assert_exit 65 "setgid-tree rejects /" bash "$WRAPPER" setgid-tree /
assert_exit 65 "setgid-tree rejects /root" bash "$WRAPPER" setgid-tree /root
assert_exit 65 "setgid-tree rejects /var/log" bash "$WRAPPER" setgid-tree /var/log
assert_exit 65 "setgid-tree rejects nonexistent Agor path" \
  bash "$WRAPPER" setgid-tree /home/nobody/agor/does-not-exist
assert_exit 65 "list-symlinks rejects /etc" bash "$WRAPPER" list-symlinks /etc
assert_exit 65 "prune-all-symlinks rejects /tmp" bash "$WRAPPER" prune-all-symlinks /tmp
assert_exit 65 "prune-broken-symlinks rejects /var" bash "$WRAPPER" prune-broken-symlinks /var

# Escape via .. → readlink -f canonicalizes then checks allowlist
TMP_OUTSIDE=$(mktemp -d)
assert_exit 65 "setgid-tree rejects symlink escape via mktemp target" \
  bash "$WRAPPER" setgid-tree "$TMP_OUTSIDE"
rmdir "$TMP_OUTSIDE" 2>/dev/null || true

# ----------------------------------------------------------------------------
# Path inside allowed tree — happy path shape check
# (We don't actually create/mutate; we only verify the wrapper doesn't reject
#  a valid Agor-managed directory at validation time. We use /tmp + symlink
#  trick to avoid persisting state, or just create a short-lived dir.)
# ----------------------------------------------------------------------------
echo "-- validate_path (happy path, allowed tree) --"
# Only run happy-path test if /var/agor exists or can be created.
if [[ -d /var/agor ]] || mkdir -p /var/agor 2>/dev/null; then
  HAPPY_DIR=/var/agor/wrapper-test-$$
  mkdir -p "$HAPPY_DIR"
  # list-symlinks on an empty allowed dir should exit 0 with no output.
  if out=$(bash "$WRAPPER" list-symlinks "$HAPPY_DIR" 2>&1); rc=$?; then :; fi
  if [[ ${rc:-99} -eq 0 ]]; then
    printf '  ok   list-symlinks on empty allowed dir exits 0\n'
    pass=$((pass + 1))
  else
    printf '  FAIL list-symlinks on empty allowed dir — exit=%s output=%s\n' "${rc:-?}" "$out"
    fail=$((fail + 1))
    failures+=("list-symlinks happy path")
  fi
  rmdir "$HAPPY_DIR" 2>/dev/null || true
else
  echo "  skip   /var/agor not writable — happy path test skipped"
fi

# ----------------------------------------------------------------------------
# assert_safe_password (stdin to set-password)
# ----------------------------------------------------------------------------
echo "-- assert_safe_password --"
# We use a username that passes the shape check but will fail at chpasswd
# (user doesn't exist). For rejection tests, we want the wrapper to exit
# 66 BEFORE ever invoking chpasswd — so the test user's existence doesn't
# matter. We pick "testuser_wrapper" which is extremely unlikely to exist.
TEST_USER="testuser_wrapper_$$"
assert_exit 66 "reject empty password" run_wrapper_stdin "" set-password "$TEST_USER"
assert_exit 66 "reject password with LF" run_wrapper_stdin $'abc\ndef' set-password "$TEST_USER"
assert_exit 66 "reject password with CR" run_wrapper_stdin $'abc\rdef' set-password "$TEST_USER"
assert_exit 66 "reject password with colon (chpasswd field injector)" \
  run_wrapper_stdin 'abc:def' set-password "$TEST_USER"
assert_exit 66 "reject password with NUL" run_wrapper_stdin $'abc\x00def' set-password "$TEST_USER"
# Non-printable high byte
assert_exit 66 "reject password with high-bit byte" \
  run_wrapper_stdin $'abc\xffdef' set-password "$TEST_USER"
# 257-byte password (over limit)
BIG=$(printf 'a%.0s' {1..260})
assert_exit 66 "reject password > 256 bytes" run_wrapper_stdin "$BIG" set-password "$TEST_USER"

# Username validation happens before stdin read in set-password, so flag-shaped
# username still fails with 65, not 66.
assert_exit 65 "set-password rejects flag-shaped username before reading stdin" \
  run_wrapper_stdin "harmless" set-password -rf

# ----------------------------------------------------------------------------
# Flag-smuggling into usermod via group argument
# ----------------------------------------------------------------------------
echo "-- flag-smuggling regressions --"
assert_exit 65 "add-to-group: flag-shaped group rejected" \
  bash "$WRAPPER" add-to-group alice --foo
assert_exit 65 "add-to-group: flag-shaped user rejected" \
  bash "$WRAPPER" add-to-group --foo developers
assert_exit 65 "remove-from-group: flag-shaped group rejected" \
  bash "$WRAPPER" remove-from-group alice --foo

# ----------------------------------------------------------------------------
# Unicode / homoglyph usernames and groupnames
# The shape regex is strictly [a-z_][a-z0-9_-]{0,31}, so every non-ASCII byte
# (Cyrillic lookalikes, full-width digits, combining marks, right-to-left
# overrides, zero-width joiners, etc.) must be rejected at 65. These are not
# hypothetical: NSS/useradd accept many Unicode strings depending on locale,
# and homoglyph attacks on admin UIs have a long history.
# ----------------------------------------------------------------------------
echo "-- unicode / homoglyph rejection --"
# Cyrillic 'а' (U+0430) looks like ASCII 'a' but is two UTF-8 bytes.
assert_exit 65 "reject Cyrillic homoglyph username (аlice)" \
  bash "$WRAPPER" add-user $'\xd0\xb0lice'
assert_exit 65 "reject Cyrillic homoglyph groupname (аdmins)" \
  bash "$WRAPPER" add-group $'\xd0\xb0dmins'
# Full-width Latin 'ａ' (U+FF41) — three UTF-8 bytes.
assert_exit 65 "reject full-width username (ａlice)" \
  bash "$WRAPPER" add-user $'\xef\xbd\x81lice'
# Zero-width joiner inside otherwise-ASCII string (U+200D).
assert_exit 65 "reject zero-width-joiner inside username" \
  bash "$WRAPPER" add-user $'al\xe2\x80\x8dice'
# Right-to-left override (U+202E) — classic filename-spoofing byte.
assert_exit 65 "reject RTL-override in username" \
  bash "$WRAPPER" add-user $'a\xe2\x80\xaelice'
# BOM prefix (U+FEFF) — invisible but illegal under the ASCII regex.
assert_exit 65 "reject BOM-prefixed username" \
  bash "$WRAPPER" add-user $'\xef\xbb\xbfalice'
# Combining acute accent after 'a' (U+0301).
assert_exit 65 "reject combining-mark username" \
  bash "$WRAPPER" add-user $'a\xcc\x81lice'
# NBSP inside a group name (U+00A0) — looks like a space.
assert_exit 65 "reject NBSP in groupname" \
  bash "$WRAPPER" add-group $'dev\xc2\xa0ops'
# Same classes in add-to-group for both user and group slots.
assert_exit 65 "add-to-group: Cyrillic user rejected" \
  bash "$WRAPPER" add-to-group $'\xd0\xb0lice' developers
assert_exit 65 "add-to-group: Cyrillic group rejected" \
  bash "$WRAPPER" add-to-group alice $'\xd0\xb4evelopers'

# Non-ASCII in home-dir argument — must also be rejected.
assert_exit 65 "add-user --home rejects Cyrillic path component" \
  bash "$WRAPPER" add-user --home $'/home/\xd0\xb0lice' alice
assert_exit 65 "add-user --home rejects home dir outside allowlist" \
  bash "$WRAPPER" add-user --home /root/alice alice
assert_exit 65 "add-user --home rejects traversal (..)" \
  bash "$WRAPPER" add-user --home /home/alice/../bob alice

# ----------------------------------------------------------------------------
# Argv newline / CR / NUL smuggling
# A literal newline in argv has historically bypassed naive regex checks that
# use ^...$ without /s or that rely on line-oriented grep. Bash's [[ =~ ]] with
# our anchors will NOT match across a newline, so these must land at 65.
# ----------------------------------------------------------------------------
echo "-- argv control-char smuggling --"
assert_exit 65 "reject newline inside username" \
  bash "$WRAPPER" add-user $'alice\nroot'
assert_exit 65 "reject CR inside username" \
  bash "$WRAPPER" add-user $'alice\rroot'
assert_exit 65 "reject tab inside username" \
  bash "$WRAPPER" add-user $'ali\tce'
assert_exit 65 "reject newline inside groupname" \
  bash "$WRAPPER" add-group $'devs\nroot'
# Leading/trailing whitespace — also outside the shape.
assert_exit 65 "reject leading newline in username" \
  bash "$WRAPPER" add-user $'\nalice'
assert_exit 65 "reject trailing newline in username" \
  bash "$WRAPPER" add-user $'alice\n'
# Newline in the --home argument is separately rejected by validate_home_dir.
assert_exit 65 "add-user --home rejects newline in path" \
  bash "$WRAPPER" add-user --home $'/home/alice\nroot' alice
# Newline in a filesystem-verb path (validate_path has an explicit control-char
# branch that beats readlink -f).
assert_exit 65 "setgid-tree rejects newline in path" \
  bash "$WRAPPER" setgid-tree $'/var/agor/wt\nroot'
assert_exit 65 "list-symlinks rejects CR in path" \
  bash "$WRAPPER" list-symlinks $'/var/agor/wt\rroot'

# Direct NUL in argv: bash generally truncates argv at NUL when using $'\x00',
# because execve's argv is NUL-terminated. We still assert the wrapper does not
# crash/accept when given a name with embedded NUL via printf — if bash strips
# the NUL and everything after, the remaining prefix still must fail the regex
# because it will equal the short prefix only. We test the observable outcome:
# exit 65 regardless of how bash chose to represent the argv slot.
assert_exit 65 "reject NUL-bearing username (observably truncated)" \
  bash "$WRAPPER" add-user $'alice\x00root'

# ----------------------------------------------------------------------------
# Audit: every rejection should be silent at auth.info level (we don't log
# failed-validation events — only successful dispatches write to syslog).
# We can't easily assert on syslog from here without a logger; just make sure
# the wrapper doesn't crash when the logger binary is absent (covered by the
# `|| true` in audit()).
# ----------------------------------------------------------------------------

echo ""
echo "== summary =="
echo "passed: $pass"
echo "failed: $fail"
if [[ $fail -gt 0 ]]; then
  echo ""
  echo "failures:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
