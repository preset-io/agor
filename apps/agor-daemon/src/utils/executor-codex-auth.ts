import { runExecutorCommand } from './spawn-executor.js';

export interface ExecutorCodexAuthRouting {
  reportedUnixUser: string | null;
  userId: string;
  /**
   * Explicit `CODEX_HOME` (the `.codex` dir) for the auth-file executor op.
   * Set in `unix_user_mode: sandbox` to the caller's per-user store `.codex` so
   * auth persists where the sandboxed session reads it. Unset otherwise (the
   * executor falls back to the effective user's `~/.codex`).
   */
  codexHome?: string;
}

export type ExecutorCodexAuthInspection =
  | {
      ok: true;
      authMode: 'chatgpt' | 'api_key';
      planType?: string;
      lastRefresh?: string;
      apiKeyStatus?: 'authenticated' | 'unauthenticated' | 'unknown';
    }
  | { ok: false; reason: 'not-found' | 'malformed' | 'unreadable' };

const options = (asUser: string | null, routing?: ExecutorCodexAuthRouting) => ({
  asUser,
  templateVariables: routing
    ? {
        unix_user: routing.reportedUnixUser ?? undefined,
        user_id: routing.userId,
      }
    : undefined,
  // In sandbox mode the auth flow runs unsandboxed as the daemon user, but the
  // executor resolves the auth file from CODEX_HOME. Point it at the caller's
  // per-user store `.codex` so the write lands where the SANDBOXED session (with
  // that store overlaid at ~) will later read it — otherwise auth.json goes to
  // the daemon home and the session can't see it. Merge OVER process.env
  // (options.env REPLACES the spawn env), keeping PATH/keys/etc.
  ...(routing?.codexHome
    ? { env: { ...(process.env as Record<string, string>), CODEX_HOME: routing.codexHome } }
    : {}),
  sensitiveOutput: true,
  timeoutMs: 10_000,
  logPrefix: '[CodexAuthExecutor]',
});

export async function inspectCodexAuthViaExecutor(
  asUser: string | null,
  routing?: ExecutorCodexAuthRouting
): Promise<ExecutorCodexAuthInspection> {
  const result = await runExecutorCommand(
    { command: 'codex.auth-file', params: { operation: 'inspect' } },
    options(asUser, routing)
  );
  if (!result.success) return { ok: false, reason: 'unreadable' };
  const data = result.data as Record<string, unknown>;
  if (data.status === 'not-found') return { ok: false, reason: 'not-found' };
  if (data.status === 'malformed') return { ok: false, reason: 'malformed' };
  if (data.status !== 'found' || (data.authMode !== 'chatgpt' && data.authMode !== 'api_key')) {
    return { ok: false, reason: 'unreadable' };
  }
  return {
    ok: true,
    authMode: data.authMode,
    ...(typeof data.planType === 'string' ? { planType: data.planType } : {}),
    ...(typeof data.lastRefresh === 'string' ? { lastRefresh: data.lastRefresh } : {}),
    ...(data.apiKeyStatus === 'authenticated' ||
    data.apiKeyStatus === 'unauthenticated' ||
    data.apiKeyStatus === 'unknown'
      ? { apiKeyStatus: data.apiKeyStatus }
      : {}),
  };
}

export async function writeCodexAuthViaExecutor(
  content: string,
  asUser: string | null,
  routing?: ExecutorCodexAuthRouting
): Promise<{ authMode: 'chatgpt' | 'api_key'; planType?: string; lastRefresh?: string }> {
  const result = await runExecutorCommand(
    { command: 'codex.auth-file', params: { operation: 'write', content } },
    options(asUser, routing)
  );
  if (!result.success) throw new Error('Executor credential write failed');
  const data = result.data as Record<string, unknown>;
  if (data.status !== 'written' || (data.authMode !== 'chatgpt' && data.authMode !== 'api_key')) {
    throw new Error('Executor credential write verification failed');
  }
  return {
    authMode: data.authMode,
    ...(typeof data.planType === 'string' ? { planType: data.planType } : {}),
    ...(typeof data.lastRefresh === 'string' ? { lastRefresh: data.lastRefresh } : {}),
  };
}

export async function deleteCodexAuthViaExecutor(
  asUser: string | null,
  routing?: ExecutorCodexAuthRouting
): Promise<void> {
  const result = await runExecutorCommand(
    { command: 'codex.auth-file', params: { operation: 'delete' } },
    options(asUser, routing)
  );
  if (!result.success) throw new Error('Executor credential delete failed');
}
