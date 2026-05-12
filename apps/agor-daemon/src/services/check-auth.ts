/**
 * Check-Auth Service
 *
 * Validates credentials for a given agentic tool without spawning a session.
 * Used by the onboarding wizard's "Test Connection" button and User Settings.
 *
 * Strategy per tool:
 * - API-key tools: lightweight HTTP call to the provider's models/user endpoint
 * - OAuth/native-auth tools: return optimistic true (CLI will gate at session time)
 *
 * Resolution precedence (when no raw key is provided by the caller):
 *   user encrypted key → config.yaml → env var → native auth
 */

import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { AgenticToolName, UserID } from '@agor/core/types';

export interface AuthCheckResult {
  authenticated: boolean;
  method: 'api-key' | 'oauth' | 'native' | 'none';
  hint?: string;
}

const TOOL_KEY_NAMES: Partial<Record<AgenticToolName, string>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
};

async function validateApiKey(tool: AgenticToolName, key: string): Promise<boolean> {
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
        url = 'https://api.github.com/user';
        headers['Authorization'] = `token ${key}`;
        headers['Accept'] = 'application/vnd.github.v3+json';
        break;
      }
      default:
        return true;
    }

    const res = await fetch(url, { method: 'GET', headers });
    return res.ok;
  } catch {
    return false;
  }
}

export function createCheckAuthService(db: Database) {
  return {
    async create(
      data: { tool: AgenticToolName; apiKey?: string },
      params?: { user?: { user_id: UserID } }
    ): Promise<AuthCheckResult> {
      const { tool, apiKey: rawKey } = data;
      const userId = params?.user?.user_id;

      // opencode is server-based — no credentials concept, always ready
      if (tool === 'opencode') {
        return { authenticated: true, method: 'native' };
      }

      const keyName = TOOL_KEY_NAMES[tool];
      if (!keyName) {
        return { authenticated: false, method: 'none', hint: 'Unsupported tool' };
      }

      // If caller provided a raw key (user typed it in the wizard), validate directly.
      if (rawKey?.trim()) {
        const ok = await validateApiKey(tool, rawKey.trim());
        return {
          authenticated: ok,
          method: 'api-key',
          hint: ok ? undefined : 'Key rejected by provider — double-check and try again.',
        };
      }

      // Otherwise resolve from stored credentials (user > config.yaml > env > native).
      const { apiKey, useNativeAuth } = await resolveApiKey(keyName as ApiKeyName, {
        userId,
        db,
        tool,
      });

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

      if (useNativeAuth) {
        // OAuth / CLI session auth — cannot validate without spawning the CLI.
        // Return optimistic true; the SDK will surface auth errors at session start.
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
