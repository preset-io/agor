import {
  credentialExecutorOptions,
  type ExecutorCredentialRouting,
} from './executor-credential-auth.js';
import { requestExecutor } from './spawn-executor.js';

export type ExecutorClaudeAuthRouting = ExecutorCredentialRouting;

const options = (routing: ExecutorClaudeAuthRouting) =>
  credentialExecutorOptions('[ClaudeAuthExecutor]', routing);

export type ExecutorClaudeAuthInspection =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'malformed' | 'unreadable' };

/**
 * Inspect `~/.claude/.credentials.json` for the target Unix user. Returns only a
 * non-secret shape verdict — never token bytes. `not-found` is a positive "no
 * login" signal; `unreadable` means we could not look (sudo/transport), which
 * callers must treat as inconclusive.
 */
export async function inspectClaudeAuthViaExecutor(
  routing: ExecutorClaudeAuthRouting
): Promise<ExecutorClaudeAuthInspection> {
  const result = await requestExecutor(
    { command: 'claude.auth-file', params: { operation: 'inspect' } },
    options(routing)
  );
  if (!result.success) return { ok: false, reason: 'unreadable' };
  const data = result.data as Record<string, unknown>;
  if (data.status === 'not-found') return { ok: false, reason: 'not-found' };
  if (data.status === 'malformed') return { ok: false, reason: 'malformed' };
  if (data.status !== 'found') return { ok: false, reason: 'unreadable' };
  return { ok: true };
}

/**
 * Write `~/.claude/.credentials.json` (0600, as the target Unix user) with the
 * daemon-built `{ claudeAiOauth: {...} }` document. Token material never returns
 * to the daemon — only a non-secret written/failed status.
 */
export async function writeClaudeAuthViaExecutor(
  content: string,
  routing: ExecutorClaudeAuthRouting,
  generation?: number
): Promise<void> {
  const result = await requestExecutor(
    {
      command: 'claude.auth-file',
      params: { operation: 'write', content, ...(generation ? { generation } : {}) },
    },
    options(routing)
  );
  if (!result.success) throw new Error('Executor credential write failed');
  const data = result.data as Record<string, unknown>;
  if (data.status !== 'written') {
    throw new Error('Executor credential write verification failed');
  }
}

export async function deleteClaudeAuthViaExecutor(
  routing: ExecutorClaudeAuthRouting,
  generation?: number
): Promise<void> {
  const result = await requestExecutor(
    {
      command: 'claude.auth-file',
      params: { operation: 'delete', ...(generation ? { generation } : {}) },
    },
    options(routing)
  );
  if (!result.success) throw new Error('Executor credential delete failed');
}
