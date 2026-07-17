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
 *   appear in argv, and ownership/0600 perms are guaranteed by `umask 077`
 *   plus an explicit `chmod` for the overwrite case.
 */

import { execFileSync } from 'node:child_process';
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

/**
 * Decode a JWT payload segment without verifying the signature. We only mine
 * display metadata (plan type) from a token the user already possesses, so
 * verification adds nothing — treat every field as untrusted display data.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = Buffer.from(segments[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Codex id_tokens nest account metadata under this claim key. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

function planTypeFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string' || !idToken) return undefined;
  const claims = decodeJwtClaims(idToken);
  const authClaim = claims?.[OPENAI_AUTH_CLAIM];
  if (!authClaim || typeof authClaim !== 'object') return undefined;
  const planType = (authClaim as Record<string, unknown>).chatgpt_plan_type;
  return typeof planType === 'string' && planType ? planType : undefined;
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
  const hasChatgptLogin = typeof refreshToken === 'string' && refreshToken.length > 0;
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
        planType: planTypeFromIdToken(tokens?.id_token),
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
 * in argv (`/proc/<pid>/cmdline`). `umask 077` covers fresh creation and the
 * explicit `chmod 600` covers overwriting a pre-existing looser file.
 */
export function writeCodexAuthFile(content: string, asUser?: string | null): void {
  if (asUser) {
    if (!isValidUnixUsername(asUser)) {
      throw new Error(`writeCodexAuthFile: invalid Unix username: ${JSON.stringify(asUser)}`);
    }
    const script =
      'umask 077; mkdir -p "$HOME/.codex"; cat > "$HOME/.codex/auth.json"; chmod 600 "$HOME/.codex/auth.json"';
    execFileSync('sudo', ['-n', '-u', asUser, 'bash', '-c', script], {
      input: content,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: SUDO_TIMEOUT_MS,
    });
    return;
  }

  const codexHome = daemonCodexHome();
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const authPath = path.join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, content, { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
}

/**
 * Read `auth.json` from the given Unix user's Codex home (or the daemon's).
 * Returns null when the file is absent or unreadable — callers treat that as
 * "no Codex login", not as an error. Contents are SECRET; never log them.
 */
export function readCodexAuthFile(asUser?: string | null): string | null {
  if (asUser) {
    if (!isValidUnixUsername(asUser)) return null;
    try {
      return execFileSync(
        'sudo',
        ['-n', '-u', asUser, 'bash', '-c', 'cat "$HOME/.codex/auth.json"'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: SUDO_TIMEOUT_MS,
        }
      );
    } catch {
      return null;
    }
  }

  try {
    return fs.readFileSync(path.join(daemonCodexHome(), 'auth.json'), 'utf8');
  } catch {
    return null;
  }
}
