import {
  credentialExecutorOptions,
  type ExecutorCredentialRouting,
} from './executor-credential-auth.js';
import { runExecutorCommand } from './spawn-executor.js';

export type ExecutorClaudeAuthRouting = ExecutorCredentialRouting;

const options = (routing: ExecutorClaudeAuthRouting) =>
  credentialExecutorOptions('[ClaudeAuthExecutor]', routing);

/**
 * Write `~/.claude/.credentials.json` (0600, as the target Unix user) with the
 * daemon-built `{ claudeAiOauth: {...} }` document. Token material never returns
 * to the daemon — only a non-secret written/failed status.
 */
export async function writeClaudeAuthViaExecutor(
  content: string,
  routing: ExecutorClaudeAuthRouting
): Promise<void> {
  const result = await runExecutorCommand(
    { command: 'claude.auth-file', params: { operation: 'write', content } },
    options(routing)
  );
  if (!result.success) throw new Error('Executor credential write failed');
  const data = result.data as Record<string, unknown>;
  if (data.status !== 'written') {
    throw new Error('Executor credential write verification failed');
  }
}

export async function deleteClaudeAuthViaExecutor(
  routing: ExecutorClaudeAuthRouting
): Promise<void> {
  const result = await runExecutorCommand(
    { command: 'claude.auth-file', params: { operation: 'delete' } },
    options(routing)
  );
  if (!result.success) throw new Error('Executor credential delete failed');
}
