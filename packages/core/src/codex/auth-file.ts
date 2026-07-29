/**
 * Codex `auth.json` helpers — parse/validate the credential file the Codex CLI
 * keeps at `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
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
 * Filesystem access deliberately does not live here. It is owned by the
 * executor command running as the resolved user identity; this module remains
 * pure so malformed or adversarial token claims cannot cause side effects.
 */

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
