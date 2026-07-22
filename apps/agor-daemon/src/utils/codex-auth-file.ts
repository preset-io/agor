/**
 * Codex `auth.json` helpers — parse/validate the credential file the Codex CLI
 * keeps at `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), and read or
 * write it on behalf of the Unix identity that will actually run Codex.
 *
 * Transplanting `auth.json` between machines is officially supported by
 * OpenAI (their container docs copy the file in verbatim); Codex refreshes
 * the tokens itself and persists them back to disk, so a one-time import is
 * a durable login.
 *
 * SECURITY CONTRACT:
 * - File contents are token material. Callers must never log them; helpers
 *   here never include file contents or parse failures' raw input in thrown
 *   errors.
 * - When a target Unix user is given, all filesystem access happens AS that
 *   user via `sudo -n -u` with content piped over stdin — token bytes never
 *   appear in argv. Writes stage a 0600 temp file and atomically rename it
 *   into place, so readers never see a torn write and a pre-existing symlink
 *   is replaced rather than followed.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidUnixUsername } from '@agor/core/unix';

/** Matches run-as-user's default; a local `cat`/`mkdir` never needs longer. */
const SUDO_TIMEOUT_MS = 5000;

/** Sanity cap — a real auth.json is a few KB; anything bigger is not one. */
const MAX_AUTH_JSON_BYTES = 64 * 1024;

export interface CodexAuthSummary {
  /** `chatgpt` when login tokens are present, `api_key` when only a key is. */
  authMode: 'chatgpt' | 'api_key';
  /** ChatGPT plan type from the id_token claims (e.g. "plus", "pro"), when parseable. */
  planType?: string;
  /** The `OPENAI_API_KEY` value when authMode is `api_key`. SECRET — never echo. */
  apiKey?: string;
  /** `last_refresh` ISO timestamp as recorded by Codex, when present. */
  lastRefresh?: string;
}

export type ParseCodexAuthResult =
  | { ok: true; normalized: string; summary: CodexAuthSummary }
  | { ok: false; error: string };

/** Codex id_tokens nest account metadata under this claim key. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Mine metadata from a Codex id_token payload (unverified — the signature is
 * not checked): the ChatGPT plan type and the account id Codex records as
 * `tokens.account_id`. Best-effort — an unparseable token yields an empty
 * result, never an error.
 *
 * Trust note: "unverified" here means safe against parse errors, not a trust
 * statement. When these claims matter (the device flow writing account_id
 * into auth.json), trust flows from having received the id_token over the
 * provider's TLS token endpoint — not from this parse.
 */
export function codexIdTokenClaims(idToken: unknown): {
  planType?: string;
  accountId?: string;
} {
  if (typeof idToken !== 'string') return {};
  const segments = idToken.split('.');
  if (segments.length !== 3) return {};
  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as unknown;
    const authClaim =
      claims && typeof claims === 'object'
        ? (claims as Record<string, unknown>)[OPENAI_AUTH_CLAIM]
        : undefined;
    if (!authClaim || typeof authClaim !== 'object') return {};
    const record = authClaim as Record<string, unknown>;
    const planType = record.chatgpt_plan_type;
    const accountId = record.chatgpt_account_id;
    return {
      ...(typeof planType === 'string' && planType ? { planType } : {}),
      ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Validate a pasted `auth.json` and normalize it for writing.
 *
 * Accepts any JSON object that carries at least one usable credential:
 * `tokens.refresh_token` (ChatGPT login) or a non-empty `OPENAI_API_KEY`.
 * Unknown fields are preserved verbatim — Codex owns this file's schema and
 * adds fields between releases; stripping them would break round-tripping.
 *
 * Error strings are user-facing and never contain the pasted input.
 */
export function parseCodexAuthJson(raw: string | undefined | null): ParseCodexAuthResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Paste the contents of your auth.json file first.' };
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_AUTH_JSON_BYTES) {
    return {
      ok: false,
      error: 'That is much larger than an auth.json file — copy just the file contents.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error:
        'That does not look like valid JSON. Copy the entire file — on the machine where Codex works, run: cat ~/.codex/auth.json',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'auth.json should be a JSON object with a "tokens" section or an "OPENAI_API_KEY".',
    };
  }

  const record = parsed as Record<string, unknown>;
  const tokens =
    record.tokens && typeof record.tokens === 'object' && !Array.isArray(record.tokens)
      ? (record.tokens as Record<string, unknown>)
      : null;
  const refreshToken = tokens?.refresh_token;
  const hasChatgptLogin = typeof refreshToken === 'string' && refreshToken.trim().length > 0;
  const apiKey = typeof record.OPENAI_API_KEY === 'string' ? record.OPENAI_API_KEY.trim() : '';

  if (!hasChatgptLogin && !apiKey) {
    return {
      ok: false,
      error:
        'This file has no ChatGPT login tokens and no API key. Sign in on the other machine first (`codex login`), then copy the fresh ~/.codex/auth.json.',
    };
  }

  const summary: CodexAuthSummary = hasChatgptLogin
    ? {
        authMode: 'chatgpt',
        planType: codexIdTokenClaims(tokens?.id_token).planType,
        lastRefresh: typeof record.last_refresh === 'string' ? record.last_refresh : undefined,
      }
    : { authMode: 'api_key', apiKey };

  return { ok: true, normalized: `${JSON.stringify(record, null, 2)}\n`, summary };
}

/** `$CODEX_HOME` only applies to the daemon's own account; impersonated users get their default. */
function daemonCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Write `auth.json` (0600) into the Codex home of the given Unix user, or of
 * the daemon user when `asUser` is null/undefined.
 *
 * The impersonated path pipes content over stdin — token bytes never appear
 * in argv (`/proc/<pid>/cmdline`). Both paths stage a 0600 temp file in the
 * Codex home and atomically rename it into place: a concurrently running
 * Codex never observes a torn half-write, a mid-stream failure (disk full)
 * leaves the previous file intact, and rename replaces a pre-existing
 * symlink itself instead of following it.
 */
export function writeCodexAuthFile(content: string, asUser?: string | null): void {
  if (asUser) {
    if (!isValidUnixUsername(asUser)) {
      throw new Error(`writeCodexAuthFile: invalid Unix username: ${JSON.stringify(asUser)}`);
    }
    // `set -eu` so any step failing aborts with a non-zero exit before the
    // rename can publish a bad file. mktemp creates the staging file 0600.
    // The EXIT trap removes an orphaned staging file on any failure so
    // aborted writes never accumulate token fragments; after a successful
    // rename the path is gone and the trap's rm is a no-op.
    const script =
      'set -eu; umask 077; mkdir -p "$HOME/.codex"; tmp="$(mktemp "$HOME/.codex/.auth.json.XXXXXX")"; trap \'rm -f -- "$tmp"\' EXIT; cat > "$tmp"; chmod 600 "$tmp"; mv -f -- "$tmp" "$HOME/.codex/auth.json"';
    execFileSync('sudo', ['-n', '-u', asUser, 'bash', '-c', script], {
      input: content,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: SUDO_TIMEOUT_MS,
    });
    return;
  }

  const codexHome = daemonCodexHome();
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by the process umask and never applied to a
  // pre-existing directory — chmod explicitly so the containing dir is 0700.
  fs.chmodSync(codexHome, 0o700);
  const tmpPath = path.join(codexHome, `.auth.json.${randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, path.join(codexHome, 'auth.json'));
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

export type ReadCodexAuthResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'not-found' | 'unreadable' };

/** Sentinel exit code the impersonated read script uses for "file absent". */
const READ_NOT_FOUND_EXIT = 3;

/**
 * Read `auth.json` from the given Unix user's Codex home (or the daemon's).
 *
 * `not-found` (file genuinely absent) is positive evidence of "no Codex
 * login"; `unreadable` (permission/sudo/transport failure) is NOT — callers
 * doing auth checks must map it to their "could not verify" state, never to
 * "unauthenticated". The impersonated script signals absence via a sentinel
 * exit code so the distinction survives the sudo boundary without parsing
 * locale-dependent stderr. Contents are SECRET; never log them.
 */
export function readCodexAuthFile(asUser?: string | null): ReadCodexAuthResult {
  if (asUser) {
    if (!isValidUnixUsername(asUser)) return { ok: false, reason: 'unreadable' };
    const script = `[ -e "$HOME/.codex/auth.json" ] || exit ${READ_NOT_FOUND_EXIT}; cat "$HOME/.codex/auth.json"`;
    try {
      const content = execFileSync('sudo', ['-n', '-u', asUser, 'bash', '-c', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SUDO_TIMEOUT_MS,
      });
      return { ok: true, content };
    } catch (err) {
      const exitStatus = (err as { status?: unknown }).status;
      return {
        ok: false,
        reason: exitStatus === READ_NOT_FOUND_EXIT ? 'not-found' : 'unreadable',
      };
    }
  }

  try {
    return {
      ok: true,
      content: fs.readFileSync(path.join(daemonCodexHome(), 'auth.json'), 'utf8'),
    };
  } catch (err) {
    return {
      ok: false,
      reason: (err as { code?: unknown }).code === 'ENOENT' ? 'not-found' : 'unreadable',
    };
  }
}
