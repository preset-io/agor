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

import { getAgenticToolIntegration, TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import { type AgorConfig, isTenantAgenticToolEnabled, resolveApiKey } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { SDKUserMessage } from '@agor/core/sdk';
import type {
  AuthCheckResult,
  AuthCheckStatus,
  AuthenticatedParams,
  DeepReadonly,
  UserID,
} from '@agor/core/types';
import { isAgenticToolName } from '@agor/core/types';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import { inspectCodexAuthViaExecutor } from '../utils/executor-codex-auth.js';
import { isRealAuthSource } from './check-auth-helpers.js';
import { resolveCodexCredentialRoute } from './codex-auth-shared.js';

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
): Promise<{ ok: boolean; account: ClaudeSdk.AccountInfo | null }> {
  let releaseHeldInput!: () => void;
  const heldInputPromise = new Promise<void>((resolve) => {
    releaseHeldInput = resolve;
  });

  // biome-ignore lint/correctness/useYield: intentional — holds the input stream open so the SDK enters streaming-input mode and accepts control requests like accountInfo(), but never sends a user message.
  async function* neverYields(): AsyncIterable<SDKUserMessage> {
    await heldInputPromise;
  }

  const Claude = await loadManagedAgenticToolSdk<typeof ClaudeSdk>('claude-code');
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
  return isRealAuthSource(probe.account?.tokenSource) ? 'authenticated' : 'unknown';
}

/**
 * Validate a concrete provider connection against the provider. `authenticated` only on a 2xx;
 * `unauthenticated` only on a real 401/403 rejection; everything else (timeout,
 * 5xx, network error) is `unknown` — a failure to VERIFY is not proof of invalidity.
 */
async function validateProviderCredential(
  tool: string,
  connection: Record<string, string | undefined>
): Promise<AuthCheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let url: string;
    const headers: Record<string, string> = {};

    switch (tool) {
      case 'claude-code': {
        url = `${(connection.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`;
        if (connection.ANTHROPIC_API_KEY) {
          headers['x-api-key'] = connection.ANTHROPIC_API_KEY;
        }
        if (connection.ANTHROPIC_AUTH_TOKEN) {
          headers.Authorization = `Bearer ${connection.ANTHROPIC_AUTH_TOKEN}`;
        }
        headers['anthropic-version'] = '2023-06-01';
        break;
      }
      case 'codex': {
        url = `${(connection.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
        headers.Authorization = `Bearer ${connection.OPENAI_API_KEY}`;
        break;
      }
      case 'gemini': {
        url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(connection.GEMINI_API_KEY ?? '')}`;
        break;
      }
      case 'copilot': {
        url = 'https://api.github.com/user';
        headers.Authorization = `token ${connection.COPILOT_GITHUB_TOKEN}`;
        headers.Accept = 'application/vnd.github.v3+json';
        break;
      }
      case 'cursor': {
        // The Cursor SDK throws on any failure and does not expose a status code,
        // so a rejection cannot be told apart from a transport error — treat a
        // successful call as authenticated and any throw as unknown (fail safe).
        const { Cursor } = await loadManagedAgenticToolSdk<typeof import('@cursor/sdk')>('cursor');
        await Promise.race([
          Cursor.me({ apiKey: connection.CURSOR_API_KEY ?? '' }),
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

function rawProviderConnection(tool: string, key: string): Record<string, string | undefined> {
  switch (tool) {
    case 'claude-code':
      return { ANTHROPIC_API_KEY: key };
    case 'codex':
      return { OPENAI_API_KEY: key };
    case 'gemini':
      return { GEMINI_API_KEY: key };
    case 'copilot':
      return { COPILOT_GITHUB_TOKEN: key };
    case 'cursor':
      return { CURSOR_API_KEY: key };
    default:
      return {};
  }
}

/** Map a validated API-key status into a full result, preserving the caller's rejection hint. */
function resultFromKeyStatus(status: AuthCheckStatus, rejectedHint: string): AuthCheckResult {
  if (status === 'authenticated') return authed('api-key');
  if (status === 'unauthenticated') return unauthenticated('api-key', rejectedHint);
  return unknown('Could not reach the provider to verify this key.');
}

/**
 * Probe the Codex `auth.json` selected by this user's credential route (the
 * local daemon home or a delegated execution-home key). File contents stay on the
 * daemon side; only shape/metadata drive the result.
 *
 * An embedded API key is verified against the provider; ChatGPT login tokens
 * cannot be verified without consuming a refresh, so a well-formed token set
 * counts as authenticated — Codex refreshes it at session start.
 */
async function probeCodexAuthFile(
  userId: UserID | undefined,
  withTenantDatabase: <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) => Promise<T>,
  config: DeepReadonly<AgorConfig>
): Promise<AuthCheckResult> {
  const identity = await resolveCodexCredentialRoute(userId, withTenantDatabase, config);
  if (!identity.ok) {
    // A missing unix_username is a real configuration gap (no credential can
    // exist for this user yet). An unsupported mode means the daemon cannot
    // see the credential at all (it lives in the execution substrate) — pass
    // that explanation through. Any other resolution failure is inconclusive.
    if (identity.reason === 'missing-username') {
      return unauthenticated(
        'none',
        'Codex subscription login needs an execution home — ask an admin to set your execution home key.'
      );
    }
    if (identity.reason === 'unsupported-mode') {
      return unknown(identity.message);
    }
    if (identity.reason === 'unsupported-home-override') {
      return unknown(identity.message);
    }
    return unknown('Could not resolve the execution home that holds the Codex login.');
  }

  const inspection = await inspectCodexAuthViaExecutor({
    delegatedHomeKey: identity.delegatedHomeKey,
    userId: identity.userId,
    codexHome: identity.codexHome,
  });
  if (!inspection.ok) {
    // Only a genuinely absent file proves "no login". Permission/launcher/
    // transport failures mean we could not LOOK, which must never surface as
    // the persistent "credentials aren't working" state.
    return inspection.reason === 'not-found'
      ? unauthenticated(
          'none',
          'No Codex login found on this server — import your auth.json or run `codex login` from a branch terminal.'
        )
      : inspection.reason === 'malformed'
        ? unauthenticated(
            'none',
            'The Codex auth file on this server is malformed — import a fresh auth.json or run `codex login` again.'
          )
        : unknown(
            'Could not inspect the Codex auth file — check executor availability and permissions.'
          );
  }

  if (inspection.authMode === 'api_key') {
    if (inspection.apiKeyStatus === 'authenticated') return authed('api-key');
    if (inspection.apiKeyStatus === 'unauthenticated') {
      return unauthenticated(
        'api-key',
        'The API key inside the Codex auth file was rejected — import a fresh auth.json.'
      );
    }
    return unknown(
      'Could not reach the provider to verify the API key inside the Codex auth file.'
    );
  }

  return authed(
    'oauth',
    inspection.planType
      ? `ChatGPT login found (${inspection.planType} plan).`
      : 'ChatGPT login found.'
  );
}

export function createCheckAuthService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
) {
  return {
    async create(
      data: { tool: string; apiKey?: string; validateNative?: boolean },
      params?: AuthenticatedParams
    ): Promise<AuthCheckResult> {
      const { tool, apiKey: rawKey } = data;
      if (!isAgenticToolName(tool)) return unknown('Unsupported tool');

      const userId = params?.user?.user_id as UserID | undefined;
      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing active tenant context for agent authentication');
      const withTenantDatabase = <T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>) =>
        runWithTenantDatabaseScope(db, tenantId, work);

      if (!(await withTenantDatabase((tenantDb) => isTenantAgenticToolEnabled(tool, tenantDb)))) {
        return unauthenticated('none', `${tool} is disabled for this workspace.`);
      }

      // Runtime-managed integrations authenticate inside their isolated native runtime.
      if (getAgenticToolIntegration(tool).authentication === 'runtime-managed') {
        return authed('native');
      }

      const keyName = TOOL_API_KEY_NAMES[tool];
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
          await validateProviderCredential(tool, rawProviderConnection(tool, rawKey.trim())),
          tool === 'copilot'
            ? 'GitHub token rejected — check the token has not expired or been revoked.'
            : 'Key rejected by provider — double-check and try again.'
        );
      }

      // Otherwise resolve from the tenant's explicit user/workspace policy.
      const { apiKey, decryptionFailed, connection, useNativeAuth } = await withTenantDatabase(
        (tenantDb) =>
          resolveApiKey(keyName, {
            userId,
            db: tenantDb,
            tool,
          })
      );

      if (decryptionFailed) {
        return unauthenticated(
          'none',
          'Stored key could not be decrypted (master-secret mismatch). Re-enter it in Settings → Agent Setup.'
        );
      }

      const resolvedConnection = {
        ...rawProviderConnection(tool, apiKey ?? ''),
        ...(connection ?? {}),
      } as Record<string, string | undefined>;

      if (tool === 'codex' && useNativeAuth) {
        // The persisted method is the cheap default used by app-shell banners.
        // Filesystem validation can require an ephemeral Cloud executor, so it
        // is reserved for an explicit user action.
        return data.validateNative
          ? probeCodexAuthFile(userId, withTenantDatabase, config)
          : unknown('ChatGPT login is configured but has not been validated.');
      }

      if (tool === 'claude-code') {
        // The atomic provider resolver returns the exact connection exported to
        // the executor. Do not reduce it to TOOL_API_KEY_NAMES: Claude also
        // supports ANTHROPIC_AUTH_TOKEN (Bearer auth) and subscription tokens.
        // Reducing this connection to ANTHROPIC_API_KEY is what made a working
        // Claude session look disconnected in the app-shell banner.
        const subscriptionToken = resolvedConnection.CLAUDE_CODE_OAUTH_TOKEN;
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

      const hasResolvedCredential =
        Boolean(apiKey) ||
        (tool === 'claude-code' && Boolean(resolvedConnection.ANTHROPIC_AUTH_TOKEN));
      if (hasResolvedCredential) {
        return resultFromKeyStatus(
          await validateProviderCredential(tool, resolvedConnection),
          'Stored key was rejected by provider — update it in Settings → Agent Setup.'
        );
      }

      return unauthenticated('none', `No usable ${keyName} is available under workspace policy.`);
    },
  };
}
