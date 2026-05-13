/**
 * Check-Auth Service
 *
 * Validates credentials for a given agentic tool without spawning a session.
 * Used by the onboarding wizard's "Test Connection" button and User Settings.
 *
 * Strategy per tool:
 * - API-key tools: lightweight HTTP call to the provider's models/user endpoint
 * - OAuth/native-auth tools (claude-code only): return optimistic true; the CLI gates at session time
 * - Server-based tools (opencode): always ready
 *
 * Resolution precedence (when no raw key is provided by the caller):
 *   user encrypted key → config.yaml → env var → native auth
 */

import { resolveApiKey } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type {
  AgenticToolName,
  AuthCheckResult,
  AuthenticatedParams,
  UserID,
} from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';

/** Tools where no API key is required — native CLI/OAuth auth is a real, usable path. */
const NATIVE_AUTH_TOOLS = new Set<string>(['claude-code']);

const FETCH_TIMEOUT_MS = 8_000;

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
        // claude-code supports `claude auth login` — optimistic success.
        // The SDK will surface auth errors at session start if CLI login is absent.
        return {
          authenticated: true,
          method: 'oauth',
          hint: 'Using CLI / OAuth authentication.',
        };
      }

      return {
        authenticated: false,
        method: 'none',
        hint: `No ${keyName} configured. Add it below or in Settings → Agent Setup.`,
      };
    },
  };
}
