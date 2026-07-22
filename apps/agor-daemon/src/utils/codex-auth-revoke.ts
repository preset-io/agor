/**
 * Best-effort revocation of a Codex ChatGPT login's OAuth tokens, mirroring
 * `codex logout` (codex-rs `login/src/auth/revoke.rs` + `manager.rs`): POST the
 * refresh token (preferred, with the public Codex `client_id`) to the provider's
 * revoke endpoint, falling back to the access token. Codex itself deletes the
 * local auth regardless of the revoke result — and so do we; this is a courtesy
 * that invalidates the tokens server-side.
 *
 * SECURITY CONTRACT:
 * - Token material is read transiently for the POST and NEVER logged; only a
 *   failure CLASS (HTTP status or error type) is surfaced.
 * - Revoking a ChatGPT refresh token is GLOBAL — it signs the account out of
 *   Codex everywhere, on every machine (openai/codex#22577). Callers warn users
 *   accordingly, especially under shared-identity Unix modes.
 */

/**
 * Public Codex CLI OAuth client id and revoke endpoint, transcribed from
 * codex-rs (`login/src/auth/manager.rs`: `CLIENT_ID` / `REVOKE_TOKEN_URL`).
 * These are public constants, not secrets. Codex allows env overrides for its
 * own tests; Agor does not need them, so they are fixed here.
 */
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
const REVOKE_TIMEOUT_MS = 5000;

export type CodexRevokeOutcome = 'revoked' | 'skipped' | 'failed';

/** Prefer the refresh token (global revocation); fall back to the access token. */
function extractRevocableToken(
  authJson: string
): { token: string; hint: 'refresh_token' | 'access_token' } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const tokens = (parsed as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const refresh = typeof t.refresh_token === 'string' ? t.refresh_token.trim() : '';
  if (refresh) return { token: refresh, hint: 'refresh_token' };
  const access = typeof t.access_token === 'string' ? t.access_token.trim() : '';
  if (access) return { token: access, hint: 'access_token' };
  return null;
}

/**
 * Attempt to revoke the tokens in a Codex `auth.json`. Never throws — returns a
 * class-level outcome so the caller can proceed to delete the local file no
 * matter what. `skipped` means there was nothing revocable (an API-key-only
 * file, or already-empty tokens).
 */
export async function revokeCodexChatgptTokens(authJson: string): Promise<CodexRevokeOutcome> {
  const found = extractRevocableToken(authJson);
  if (!found) return 'skipped';

  const body: Record<string, string> = {
    token: found.token,
    token_type_hint: found.hint,
    // codex-rs attaches the client_id only when revoking a refresh token.
    ...(found.hint === 'refresh_token' ? { client_id: CODEX_OAUTH_CLIENT_ID } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return 'revoked';
    // Status only — never the request body / token or the response body.
    console.warn(
      `[CodexAuth] Token revocation returned HTTP ${res.status} — removing local login anyway.`
    );
    return 'failed';
  } catch (err) {
    console.warn(
      `[CodexAuth] Token revocation failed (${
        err instanceof Error ? err.constructor.name : 'unknown error'
      }) — removing local login anyway.`
    );
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
