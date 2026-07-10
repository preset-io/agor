/**
 * Native (CLI / OAuth) auth probing for agentic tools, shared by the check-auth
 * service and the missing-credential classifier. Statically imports the Claude
 * Agent SDK, so consumers that must stay SDK-free (e.g. vitest'd hooks) should
 * pull it in via dynamic `import()` rather than a top-level import.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@agor/core/sdk';
import { Claude } from '@agor/core/sdk';
import type { AuthCheckResult } from '@agor/core/types';
import { isRealAuthSource } from './check-auth-helpers.js';

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
export async function probeClaudeCodeAuth(
  env?: Record<string, string>
): Promise<Claude.AccountInfo | null> {
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

export type CodexAuthProbeResult = {
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
export async function probeCodexAuth(): Promise<CodexAuthProbeResult | null> {
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

/**
 * Whether native CLI/OAuth auth currently works for `tool`. This is the same
 * "authenticated?" determination check-auth surfaces, reduced to a boolean for
 * callers (like the missing-credential classifier) that only need yes/no.
 */
export async function checkNativeAuth(tool: string): Promise<boolean> {
  if (tool === 'claude-code') {
    const account = await probeClaudeCodeAuth();
    // `accountInfo()` returns an object with all-optional fields; an empty {}
    // means the SDK initialized but found no credentials. Require at least one
    // real auth-indicating field to call it authenticated.
    return !!(
      account &&
      (isRealAuthSource(account.apiKeySource) ||
        isRealAuthSource(account.tokenSource) ||
        account.email)
    );
  }
  if (tool === 'codex') {
    const result = await probeCodexAuth();
    return result?.authenticated === true;
  }
  return false;
}
