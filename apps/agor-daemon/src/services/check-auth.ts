/**
 * Check-Auth Service
 *
 * Validates credentials for a given agentic tool without spawning a session.
 * Used by the onboarding wizard's "Test Connection" button, User Settings, and
 * the post-onboarding banners.
 *
 * Returns a tri-state `status`:
 * - `authenticated`: a working credential was positively confirmed.
 * - `unauthenticated`: no usable scoped credential, or provider rejection.
 * - `unknown`: could NOT determine — transport error, provider timeout/5xx, or a
 *   credential class with no reliable probe. Callers must fail safe.
 *
 * Resolution follows the tenant's explicit policy and selects one complete
 * user or workspace connection. Native CLI state, YAML, and environment
 * variables are not credential fallbacks.
 */

import { isTenantAgenticToolEnabled, resolveApiKey } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { SDKUserMessage } from '@agor/core/sdk';
import { Claude } from '@agor/core/sdk';
import type {
  AgenticToolName,
  AuthCheckResult,
  AuthCheckStatus,
  AuthenticatedParams,
  UserID,
} from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';

const FETCH_TIMEOUT_MS = 8_000;
const SDK_AUTH_PROBE_TIMEOUT_MS = 10_000;

const authed = (method: AuthCheckResult['method'], hint?: string): AuthCheckResult => ({
  status: 'authenticated',
  authenticated: true,
  method,
  hint,
});

const unauthenticated = (method: AuthCheckResult['method'], hint?: string): AuthCheckResult => ({
  status: 'unauthenticated',
  authenticated: false,
  method,
  hint,
});

const unknown = (hint?: string): AuthCheckResult => ({
  status: 'unknown',
  authenticated: false,
  method: 'none',
  hint,
});

/**
 * Verify Claude Code auth by spawning the SDK in streaming-input mode and reading
 * `accountInfo()` from its init handshake. When `env` is supplied it REPLACES the
 * subprocess environment (per the SDK contract), so callers must layer the
 * credential on a minimal safe env — used to inject a resolved subscription/OAuth
 * token so the probe sees it exactly as a real session would.
 *
 * `ok: false` means the isolated token probe failed (timeout or exception), so
 * the result is inconclusive rather than proof that the token is invalid.
 */
async function probeClaudeCodeAuth(
  env?: Record<string, string | undefined>
): Promise<{ ok: boolean; account: Claude.AccountInfo | null }> {
  let releaseHeldInput!: () => void;
  const heldInputPromise = new Promise<void>((resolve) => {
    releaseHeldInput = resolve;
  });

  // biome-ignore lint/correctness/useYield: intentional — holds the input stream open so the SDK enters streaming-input mode and accepts control requests like accountInfo(), but never sends a user message.
  async function* neverYields(): AsyncIterable<SDKUserMessage> {
    await heldInputPromise;
  }

  const q = Claude.query({
    prompt: neverYields(),
    options: env ? { env } : {},
  });

  try {
    const account = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth probe timed out')), SDK_AUTH_PROBE_TIMEOUT_MS)
      ),
    ]);
    return { ok: true, account: account ?? null };
  } catch {
    return { ok: false, account: null };
  } finally {
    releaseHeldInput();
    try {
      q.close();
    } catch {
      // best-effort cleanup
    }
  }
}

/** Claude subscription tokens from `claude setup-token` carry an `sk-ant-oat` prefix. */
function isClaudeSubscriptionToken(token: string): boolean {
  return token.trim().startsWith('sk-ant-oat');
}

/**
 * Build a MINIMAL probe env carrying only the subscription token (plus PATH and
 * proxy vars) so the SDK validates in isolation without leaking all daemon env.
 */
function buildClaudeProbeEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: token.trim(),
  };

  // The SDK uses an explicit bundled Claude binary path, but preserving PATH
  // keeps child-process basics working without exposing all daemon env vars.
  if (process.env.PATH) env.PATH = process.env.PATH;

  // Preserve common proxy settings so validation works in proxied installs.
  for (const key of [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  return env;
}

/**
 * Validate a Claude subscription token by injecting it into an isolated probe env.
 * A probe failure (timeout/exception) is `unknown`, not proof of an invalid token.
 */
async function validateClaudeSubscriptionToken(token: string): Promise<AuthCheckStatus> {
  const probe = await probeClaudeCodeAuth(buildClaudeProbeEnv(token));
  if (!probe.ok) return 'unknown';
  // accountInfo() is not a reliable negative signal for setup-token auth: some
  // valid subscription sessions initialize without returning account metadata.
  // Only positive account metadata proves auth; absence is inconclusive and
  // must not drive the persistent "credentials aren't working" banner.
  return probe.account?.tokenSource ? 'authenticated' : 'unknown';
}

/**
 * Validate a concrete API key against the provider. `authenticated` only on a 2xx;
 * `unauthenticated` only on a real 401/403 rejection; everything else (timeout,
 * 5xx, network error) is `unknown` — a failure to VERIFY is not proof of invalidity.
 */
async function validateApiKey(
  tool: string,
  key: string,
  connection: Record<string, string | undefined> = {}
): Promise<AuthCheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let url: string;
    const headers: Record<string, string> = {};

    switch (tool) {
      case 'claude-code': {
        url = `${(connection.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`;
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        break;
      }
      case 'codex': {
        url = `${(connection.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
        headers.Authorization = `Bearer ${key}`;
        break;
      }
      case 'gemini': {
        url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(key)}`;
        break;
      }
      case 'copilot': {
        url = 'https://api.github.com/user';
        headers.Authorization = `token ${key}`;
        headers.Accept = 'application/vnd.github.v3+json';
        break;
      }
      case 'cursor': {
        // The Cursor SDK throws on any failure and does not expose a status code,
        // so a rejection cannot be told apart from a transport error — treat a
        // successful call as authenticated and any throw as unknown (fail safe).
        const { Cursor } = await import('@cursor/sdk');
        await Promise.race([
          Cursor.me({ apiKey: key }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Cursor auth check timed out')), FETCH_TIMEOUT_MS)
          ),
        ]);
        return 'authenticated';
      }
      default:
        return 'unknown';
    }

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.ok) return 'authenticated';
    if (res.status === 401 || res.status === 403) return 'unauthenticated';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** Map a validated API-key status into a full result, preserving the caller's rejection hint. */
function resultFromKeyStatus(status: AuthCheckStatus, rejectedHint: string): AuthCheckResult {
  if (status === 'authenticated') return authed('api-key');
  if (status === 'unauthenticated') return unauthenticated('api-key', rejectedHint);
  return unknown('Could not reach the provider to verify this key.');
}

export function createCheckAuthService(db: TenantScopeAwareDatabase) {
  return {
    async create(
      data: { tool: string; apiKey?: string },
      params?: AuthenticatedParams
    ): Promise<AuthCheckResult> {
      const { tool, apiKey: rawKey } = data;
      const userId = params?.user?.user_id as UserID | undefined;

      if (!(await isTenantAgenticToolEnabled(tool as AgenticToolName, db))) {
        return unauthenticated('none', `${tool} is disabled for this workspace.`);
      }

      // opencode is server-based — no credentials concept, always ready.
      if (tool === 'opencode') {
        return authed('native');
      }

      const keyName = TOOL_API_KEY_NAMES[tool as keyof typeof TOOL_API_KEY_NAMES];
      if (!keyName) {
        return unknown('Unsupported tool');
      }

      // Caller provided a raw key (wizard / settings "Test Connection") — validate directly.
      // Claude subscription tokens from `claude setup-token` are not Anthropic Console
      // API keys; the Claude SDK/CLI reads them from CLAUDE_CODE_OAUTH_TOKEN.
      if (rawKey?.trim()) {
        if (tool === 'claude-code' && isClaudeSubscriptionToken(rawKey)) {
          const status = await validateClaudeSubscriptionToken(rawKey);
          if (status === 'authenticated') return authed('oauth');
          if (status === 'unauthenticated') {
            return unauthenticated(
              'none',
              'Claude subscription token rejected — run `claude setup-token` again and paste the fresh token.'
            );
          }
          return unknown('Could not verify the Claude subscription token — try again.');
        }

        return resultFromKeyStatus(
          await validateApiKey(tool, rawKey.trim()),
          tool === 'copilot'
            ? 'GitHub token rejected — check the token has not expired or been revoked.'
            : 'Key rejected by provider — double-check and try again.'
        );
      }

      // Otherwise resolve from the tenant's explicit user/workspace policy.
      const toolName = tool as AgenticToolName;
      const { apiKey, decryptionFailed, connection, useNativeAuth } = await resolveApiKey(keyName, {
        userId,
        db,
        tool: toolName,
      });

      if (decryptionFailed) {
        return unauthenticated(
          'none',
          'Stored key could not be decrypted (master-secret mismatch). Re-enter it in Settings → Agent Setup.'
        );
      }

      if (apiKey) {
        return resultFromKeyStatus(
          await validateApiKey(tool, apiKey, connection as Record<string, string | undefined>),
          'Stored key was rejected by provider — update it in Settings → Agent Setup.'
        );
      }

      if (tool === 'codex' && useNativeAuth) {
        return unknown(
          'Codex subscription login is configured for this user but can only be verified when Codex runs.'
        );
      }

      if (tool === 'claude-code') {
        const subscriptionResolution = await resolveApiKey('CLAUDE_CODE_OAUTH_TOKEN', {
          userId,
          db,
          tool: 'claude-code',
        });

        if (subscriptionResolution.decryptionFailed) {
          return unauthenticated(
            'none',
            'Stored Claude subscription token could not be decrypted (master-secret mismatch). Re-enter it in Settings → Agent Setup.'
          );
        }

        const subscriptionToken = subscriptionResolution.apiKey;
        if (subscriptionToken) {
          const status = await validateClaudeSubscriptionToken(subscriptionToken);
          if (status === 'authenticated') return authed('oauth');
          if (status === 'unauthenticated') {
            return unauthenticated(
              'none',
              'Stored Claude subscription token was rejected — update it in Settings → Agent Setup.'
            );
          }
          return unknown('Could not verify the Claude subscription token — try again.');
        }
      }

      return unauthenticated('none', `No usable ${keyName} is available under workspace policy.`);
    },
  };
}
