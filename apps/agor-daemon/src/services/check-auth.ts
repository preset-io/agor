/**
 * Check-Auth Service
 *
 * Validates credentials for a given agentic tool without spawning a session.
 * Used by the onboarding wizard's "Test Connection" button, User Settings, and
 * the post-onboarding banners.
 *
 * Returns a tri-state `status`:
 * - `authenticated`: a working credential was positively confirmed.
 * - `unauthenticated`: positively proven to have NO working credential (empty
 *   native auth, absent/invalid auth file, provider 401/403 on a present key).
 * - `unknown`: could NOT determine — transport error, provider timeout/5xx, or a
 *   credential class with no server-probeable path (gemini Google-login, cursor,
 *   copilot native). Callers must FAIL SAFE and treat this as "possibly connected".
 *
 * Credential resolution mirrors what the executor sees at session-start: the
 * primary per-tool credential (DB `agentic_tools` > config.yaml > OS env, via
 * `resolveApiKey`), then the tool's user `env_vars` and a Claude subscription
 * token, then the native filesystem path (claude via the SDK's `accountInfo()`
 * reading `~/.claude/.credentials.json`; codex reading `~/.codex/auth.json`).
 *
 * Residual: in insulated/strict Unix modes the probe runs as the DAEMON Unix user,
 * whose `~/.claude` / `~/.codex` may diverge from the executor user's. The full
 * `sudo -u <session user>` probe is a follow-up; here we still FAIL SAFE (a
 * divergence surfaces as `unknown`, never a false "not connected").
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, resolveUserEnvironment } from '@agor/core/config';
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

/** Tools where no API key is required — native CLI/OAuth auth is a real, usable path. */
const NATIVE_AUTH_TOOLS = new Set<string>(['claude-code', 'codex']);

const FETCH_TIMEOUT_MS = 8_000;
const SDK_AUTH_PROBE_TIMEOUT_MS = 10_000;
// Codex treats the OAuth session as stale after ~8 days (per OpenAI docs).
const CODEX_SESSION_STALE_MS = 8 * 24 * 60 * 60 * 1000;

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
 * `ok: false` means the probe itself failed (CLI missing, timeout, exception) —
 * an inconclusive `unknown`, NOT proof of missing auth. `ok: true` with an empty
 * account is positive proof of no native auth.
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

/** Turn a Claude `accountInfo()` probe into a tool result (authenticated) or an evidence status. */
function classifyClaudeProbe(probe: {
  ok: boolean;
  account: Claude.AccountInfo | null;
}): AuthCheckResult {
  if (!probe.ok) return unknown('Claude Code auth probe did not complete.');
  const { account } = probe;
  const hasAuthSignal = !!(account?.apiKeySource || account?.tokenSource || account?.email);
  if (hasAuthSignal && account) {
    const method: AuthCheckResult['method'] = account.apiKeySource
      ? 'api-key'
      : account.tokenSource
        ? 'oauth'
        : 'native';
    const hintParts: string[] = [];
    if (account.email) hintParts.push(account.email);
    if (account.subscriptionType) hintParts.push(account.subscriptionType);
    if (account.organization) hintParts.push(account.organization);
    return authed(method, hintParts.length > 0 ? hintParts.join(' • ') : undefined);
  }
  return unauthenticated('none', 'No Claude Code authentication detected.');
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
  return probe.account?.tokenSource ? 'authenticated' : 'unauthenticated';
}

/**
 * Shape of `$CODEX_HOME/auth.json` — the file the codex CLI writes after a
 * successful login. The executor reads from the same path.
 */
interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  last_refresh?: string;
  OPENAI_API_KEY?: string;
}

/**
 * Probe Codex auth by reading `$CODEX_HOME/auth.json` (default `~/.codex`).
 * Absent / unreadable / malformed / empty is positive proof of no native auth.
 */
async function probeCodexAuth(): Promise<AuthCheckResult> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const authPath = join(codexHome, 'auth.json');

  let parsed: CodexAuthFile;
  try {
    const raw = await fs.readFile(authPath, 'utf-8');
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch {
    return unauthenticated('none', 'No Codex authentication detected.');
  }

  // ChatGPT OAuth path — the CLI auto-refreshes via refresh_token, but OpenAI
  // considers the session stale after ~8 days without a refresh.
  if (parsed.tokens?.refresh_token) {
    if (parsed.last_refresh) {
      const refreshedAt = Date.parse(parsed.last_refresh);
      if (Number.isFinite(refreshedAt) && Date.now() - refreshedAt > CODEX_SESSION_STALE_MS) {
        return unauthenticated(
          'oauth',
          'Codex ChatGPT session is stale (>8 days since last refresh). Run `codex` once to refresh.'
        );
      }
    }
    return authed(
      'oauth',
      parsed.auth_mode ? `ChatGPT (${parsed.auth_mode})` : 'ChatGPT subscription auth'
    );
  }

  // API key persisted into auth.json (set via `codex login --api-key`).
  if (parsed.OPENAI_API_KEY) {
    return authed('api-key', 'Using OPENAI_API_KEY from ~/.codex/auth.json');
  }

  return unauthenticated('none', 'No Codex authentication detected.');
}

/**
 * Validate a concrete API key against the provider. `authenticated` only on a 2xx;
 * `unauthenticated` only on a real 401/403 rejection; everything else (timeout,
 * 5xx, network error) is `unknown` — a failure to VERIFY is not proof of invalidity.
 */
async function validateApiKey(tool: string, key: string): Promise<AuthCheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let url: string;
    const headers: Record<string, string> = {};

    switch (tool) {
      case 'claude-code': {
        url = 'https://api.anthropic.com/v1/models';
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        break;
      }
      case 'codex': {
        url = 'https://api.openai.com/v1/models';
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

      // Otherwise resolve from stored credentials (user > config.yaml > env > native).
      const toolName = tool as AgenticToolName;
      const { apiKey, useNativeAuth, decryptionFailed } = await resolveApiKey(keyName, {
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

      let effectiveUserEnv: Record<string, string> | undefined;
      const getEffectiveUserEnv = async () => {
        if (!userId) return {};
        effectiveUserEnv ??= await resolveUserEnvironment(userId, db, { tool: toolName });
        return effectiveUserEnv;
      };

      if (apiKey) {
        return resultFromKeyStatus(
          await validateApiKey(tool, apiKey),
          'Stored key was rejected by provider — update it in Settings → Agent Setup.'
        );
      }

      // User Settings → Env Vars is not the recommended credential home, but executors
      // do receive those values. Validate that setup through the same user/tool env
      // resolver used to spawn sessions.
      const userEnv = await getEffectiveUserEnv();
      const userEnvApiKey = userEnv[keyName];
      if (userEnvApiKey) {
        return resultFromKeyStatus(
          await validateApiKey(tool, userEnvApiKey),
          'Stored env var key was rejected by provider — update it in Settings → Env Vars.'
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

        const subscriptionToken = subscriptionResolution.apiKey || userEnv.CLAUDE_CODE_OAUTH_TOKEN;
        if (subscriptionToken) {
          const status = await validateClaudeSubscriptionToken(subscriptionToken);
          if (status === 'authenticated') return authed('oauth');
          if (status === 'unauthenticated') {
            return unauthenticated(
              'none',
              subscriptionResolution.apiKey
                ? 'Stored Claude subscription token was rejected — update it in Settings → Agent Setup.'
                : 'Claude subscription token env var was rejected — update CLAUDE_CODE_OAUTH_TOKEN in Settings → Env Vars.'
            );
          }
          return unknown('Could not verify the Claude subscription token — try again.');
        }
      }

      // Native filesystem auth for the tools that have a server-probeable path.
      if (useNativeAuth && NATIVE_AUTH_TOOLS.has(tool)) {
        if (tool === 'claude-code') {
          return classifyClaudeProbe(await probeClaudeCodeAuth());
        }
        if (tool === 'codex') {
          return probeCodexAuth();
        }
      }

      // gemini / copilot / cursor: an API key is verifiable, but their native login
      // (Google account, Cursor, Copilot) is NOT server-probeable — no key ⇒ unknown.
      return unknown(
        `No ${keyName} configured and ${toolName} native login can't be verified from the server.`
      );
    },
  };
}
