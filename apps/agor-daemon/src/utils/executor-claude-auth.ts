import { runExecutorCommand } from './spawn-executor.js';

/**
 * Routing for the Unix identity that owns the Claude login file. Mirrors
 * {@link import('./executor-codex-auth.js').ExecutorCodexAuthRouting} — the
 * daemon derives this from the authenticated user, never from request data.
 */
export interface ExecutorClaudeAuthRouting {
  reportedUnixUser: string | null;
  userId: string;
}

const options = (asUser: string | null, routing?: ExecutorClaudeAuthRouting) => ({
  asUser,
  templateVariables: routing
    ? {
        unix_user: routing.reportedUnixUser ?? undefined,
        user_id: routing.userId,
      }
    : undefined,
  sensitiveOutput: true,
  timeoutMs: 10_000,
  logPrefix: '[ClaudeAuthExecutor]',
});

/**
 * Write `~/.claude/.credentials.json` (0600, as the target Unix user) with the
 * daemon-built `{ claudeAiOauth: {...} }` document. Token material never returns
 * to the daemon — only a non-secret written/failed status.
 */
export async function writeClaudeAuthViaExecutor(
  content: string,
  asUser: string | null,
  routing?: ExecutorClaudeAuthRouting
): Promise<void> {
  const result = await runExecutorCommand(
    { command: 'claude.auth-file', params: { operation: 'write', content } },
    options(asUser, routing)
  );
  if (!result.success) throw new Error('Executor credential write failed');
  const data = result.data as Record<string, unknown>;
  if (data.status !== 'written') {
    throw new Error('Executor credential write verification failed');
  }
}

export async function deleteClaudeAuthViaExecutor(
  asUser: string | null,
  routing?: ExecutorClaudeAuthRouting
): Promise<void> {
  const result = await runExecutorCommand(
    { command: 'claude.auth-file', params: { operation: 'delete' } },
    options(asUser, routing)
  );
  if (!result.success) throw new Error('Executor credential delete failed');
}
