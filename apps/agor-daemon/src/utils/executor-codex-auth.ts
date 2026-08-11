import { runExecutorCommand } from './spawn-executor.js';

export interface ExecutorCodexAuthRouting {
  reportedUnixUser: string | null;
  userId: string;
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
