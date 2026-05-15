/**
 * Check-Auth Service
 *
 * Validates credentials for a given agentic tool without spawning a session.
 * Used by the onboarding wizard's "Test Connection" button and User Settings.
 *
 * Strategy per tool:
 * - API-key tools: lightweight HTTP call to the provider's models/user endpoint
 * - claude-code native auth: probe the Agent SDK in streaming-input mode and
 *   read `accountInfo()` — this matches exactly what the executor sees at
 *   session-start, so a green check here means sessions will work
 * - codex native auth: inspect `$CODEX_HOME/auth.json` (the same file the
 *   codex CLI writes after `codex login`). Executor reads from the same path,
 *   so a green check matches session behavior in simple Unix mode
 * - Server-based tools (opencode): always ready
 *
 * Resolution precedence (when no raw key is provided by the caller):
 *   user encrypted key → config.yaml → env var → native auth
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { SDKUserMessage } from '@agor/core/sdk';
import { Claude } from '@agor/core/sdk';
import type {
  AgenticToolName,
  AuthCheckResult,
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

/**
 * Verify Claude Code auth by spawning the SDK in streaming-input mode and
 * reading `accountInfo()` from its init handshake. The SDK launches the
 * `claude` CLI in the same context the executor will at session-start, so a
 * successful probe means real sessions will resolve creds the same way.
 *
 * We pass an AsyncIterable that yields nothing — control requests like
 * `accountInfo()` require streaming-input mode, but never yielding means no
 * user message is sent and no API call is made. Cleanup releases the held
 * iterable and closes the query so the subprocess exits.
 *
 * Returns null on any failure (CLI missing, no auth, timeout, etc.).
 */
async function probeClaudeCodeAuth(): Promise<Claude.AccountInfo | null> {
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
    options: {},
  });

  try {
    const account = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth probe timed out')), SDK_AUTH_PROBE_TIMEOUT_MS)
      ),
    ]);
    return account ?? null;
  } catch {
    return null;
  } finally {
    releaseHeldInput();
    try {
      q.close();
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Shape of `$CODEX_HOME/auth.json` — the file the codex CLI writes after a
 * successful login. The executor reads from the same path (it explicitly
 * does NOT override CODEX_HOME), so this is the authoritative signal for
 * "will a Codex session start without a 'not logged in' error?"
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

type CodexAuthProbeResult = {
  authenticated: boolean;
  method: AuthCheckResult['method'];
  hint?: string;
};

/**
 * Probe Codex auth by reading `$CODEX_HOME/auth.json` (default `~/.codex`).
 * The Codex SDK does not expose an `accountInfo()` equivalent, so file
 * inspection is the cleanest non-network check — and it mirrors exactly
 * what the executor's Codex prompt-service does at session start.
 */
async function probeCodexAuth(): Promise<CodexAuthProbeResult | null> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const authPath = join(codexHome, 'auth.json');

  let parsed: CodexAuthFile;
  try {
    const raw = await fs.readFile(authPath, 'utf-8');
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch {
    // No auth.json, unreadable, or malformed — treat as not authenticated.
    return null;
  }

  // ChatGPT OAuth path — the CLI auto-refreshes via refresh_token, but
  // OpenAI considers the session stale after ~8 days without a refresh.
  if (parsed.tokens?.refresh_token) {
    if (parsed.last_refresh) {
      const refreshedAt = Date.parse(parsed.last_refresh);
      if (Number.isFinite(refreshedAt) && Date.now() - refreshedAt > CODEX_SESSION_STALE_MS) {
        return {
          authenticated: false,
          method: 'oauth',
          hint: 'Codex ChatGPT session is stale (>8 days since last refresh). Run `codex` once to refresh.',
        };
      }
    }
    return {
      authenticated: true,
      method: 'oauth',
      hint: parsed.auth_mode ? `ChatGPT (${parsed.auth_mode})` : 'ChatGPT subscription auth',
    };
  }

  // API key persisted into auth.json (set via `codex login --api-key`).
  if (parsed.OPENAI_API_KEY) {
    return {
      authenticated: true,
      method: 'api-key',
      hint: 'Using OPENAI_API_KEY from ~/.codex/auth.json',
    };
  }

  return null;
}

async function validateApiKey(tool: string, key: string): Promise<boolean> {
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
        headers['Authorization'] = `Bearer ${key}`;
        break;
      }
      case 'gemini': {
        url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(key)}`;
        break;
      }
      case 'copilot': {
        // Validates the GitHub token is accepted. Note: does NOT verify Copilot
        // entitlement or model access — just that the token is a valid GitHub credential.
        url = 'https://api.github.com/user';
        headers['Authorization'] = `token ${key}`;
        headers['Accept'] = 'application/vnd.github.v3+json';
        break;
      }
      default:
        return false;
    }

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createCheckAuthService(db: Database) {
  return {
    async create(
      data: { tool: string; apiKey?: string },
      params?: AuthenticatedParams
    ): Promise<AuthCheckResult> {
      const { tool, apiKey: rawKey } = data;
      const userId = params?.user?.user_id as UserID | undefined;

      // opencode is server-based — no credentials concept, always ready
      if (tool === 'opencode') {
        return { authenticated: true, method: 'native' };
      }

      const keyName = TOOL_API_KEY_NAMES[tool as keyof typeof TOOL_API_KEY_NAMES];
      if (!keyName) {
        return { authenticated: false, method: 'none', hint: 'Unsupported tool' };
      }

      // If caller provided a raw key (user typed it in the wizard), validate directly.
      if (rawKey?.trim()) {
        const ok = await validateApiKey(tool, rawKey.trim());
        return {
          authenticated: ok,
          method: 'api-key',
          hint: ok
            ? undefined
            : tool === 'copilot'
              ? 'GitHub token rejected — check the token has not expired or been revoked.'
              : 'Key rejected by provider — double-check and try again.',
        };
      }

      // Otherwise resolve from stored credentials (user > config.yaml > env > native).
      const { apiKey, useNativeAuth, decryptionFailed } = await resolveApiKey(keyName, {
        userId,
        db,
        tool: tool as AgenticToolName,
      });

      if (decryptionFailed) {
        return {
          authenticated: false,
          method: 'none',
          hint: 'Stored key could not be decrypted (master-secret mismatch). Re-enter it in Settings → Agent Setup.',
        };
      }

      if (apiKey) {
        const ok = await validateApiKey(tool, apiKey);
        return {
          authenticated: ok,
          method: 'api-key',
          hint: ok
            ? undefined
            : 'Stored key was rejected by provider — update it in Settings → Agent Setup.',
        };
      }

      if (useNativeAuth && NATIVE_AUTH_TOOLS.has(tool)) {
        // Actually verify CLI / OAuth auth — previously we returned an
        // optimistic `true` here, which let users finish onboarding only to
        // hit "not logged in" at session start.
        if (tool === 'claude-code') {
          const account = await probeClaudeCodeAuth();
          // `accountInfo()` resolves with an object whose fields are ALL
          // optional. An empty {} comes back when the SDK could initialize
          // but found no credentials — treat that as not-authenticated.
          // Need at least one auth-indicating field to call it real.
          const hasAuthSignal = !!(
            account &&
            (account.apiKeySource || account.tokenSource || account.email)
          );
          // Surface what the probe actually saw — invaluable when the wizard
          // says "authenticated" but the session can't find creds.
          console.log(
            `[check-auth/claude-code] probe result: ${
              hasAuthSignal
                ? `authenticated (apiKeySource=${account!.apiKeySource ?? '-'} tokenSource=${account!.tokenSource ?? '-'} email=${account!.email ?? '-'})`
                : `not authenticated (account=${account ? JSON.stringify(account) : 'null'})`
            }`
          );
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
            return {
              authenticated: true,
              method,
              hint: hintParts.length > 0 ? hintParts.join(' • ') : undefined,
            };
          }
          return {
            authenticated: false,
            method: 'none',
            hint: 'No Claude Code authentication detected. Paste an ANTHROPIC_API_KEY below, or run `claude auth login` in the terminal Agor runs as.',
          };
        }

        if (tool === 'codex') {
          const result = await probeCodexAuth();
          if (result?.authenticated) {
            return {
              authenticated: true,
              method: result.method,
              hint: result.hint,
            };
          }
          return {
            authenticated: false,
            method: 'none',
            hint:
              result?.hint ??
              'No Codex authentication detected. Paste an OPENAI_API_KEY below, or run `codex` in the terminal Agor runs as to sign in with ChatGPT.',
          };
        }
      }

      return {
        authenticated: false,
        method: 'none',
        hint: `No ${keyName} configured. Add it below or in Settings → Agent Setup.`,
      };
    },
  };
}
