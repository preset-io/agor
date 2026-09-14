import type { AgorClient } from '@agor-live/client';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

export interface StartTeammateBootstrapSessionInput<
  TSessionConfig,
  TInitialization extends { sessionId: string; initializationFailed?: true },
> {
  client: AgorClient | null;
  branchId: string;
  boardId: string;
  sessionConfig: TSessionConfig;
  onCreateSession: (config: TSessionConfig, boardId: string) => Promise<TInitialization | null>;
  onStatusChange?: (status: string) => void;
  /** Abort caller-owned stages after an authenticated-identity change. */
  shouldContinue?: () => boolean;
  /** Retain the durable ID even if first-prompt initialization failed. */
  onSessionCreated?: (sessionId: string) => Promise<void>;
}

/**
 * Shared bootstrap-session runner for newly created AI teammates.
 *
 * Keeps the branch-filesystem readiness wait and first-session create behavior
 * consistent between onboarding and the Teammate create dialog while letting
 * each caller own its own navigation/fallback UI.
 */
export async function startTeammateBootstrapSession<
  TSessionConfig,
  TInitialization extends { sessionId: string; initializationFailed?: true },
>({
  client,
  branchId,
  boardId,
  sessionConfig,
  onCreateSession,
  onStatusChange,
  shouldContinue = () => true,
  onSessionCreated,
}: StartTeammateBootstrapSessionInput<TSessionConfig, TInitialization>): Promise<TInitialization> {
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  onStatusChange?.('Preparing AI teammate worktree…');
  await waitForBranchFilesystemReady(client, branchId);

  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  onStatusChange?.('Starting first session…');
  const initialization = await onCreateSession(sessionConfig, boardId);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  if (!initialization) {
    throw new Error('First AI teammate session could not be created.');
  }

  await onSessionCreated?.(initialization.sessionId);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  if (initialization.initializationFailed)
    throw new Error(
      'The first teammate session could not start. Your workspace is saved; retry setup.'
    );

  return initialization;
}

/** Recover a retained session without creating another session or resending an admitted prompt. */
export async function resumeTeammateBootstrapSession(
  client: AgorClient | null,
  sessionId: string,
  branchId: string,
  options: Parameters<AgorClient['sessions']['initialize']>[1],
  shouldContinue: () => boolean
): Promise<void> {
  if (!client || !shouldContinue()) throw new Error('Reconnect to resume teammate setup.');
  const session = await client.service('sessions').get(sessionId);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  if (session.session_id !== sessionId || session.branch_id !== branchId)
    throw new Error('The retained session does not belong to this teammate.');
  const result = await client
    .service('tasks')
    .find({ query: { session_id: sessionId, $limit: 1 } });
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  const tasks = Array.isArray(result) ? result : result.data;
  if (tasks.length) {
    if (tasks.some((task) => task.session_id !== sessionId))
      throw new Error('The retained session returned unexpected task data.');
    return;
  }
  await client.sessions.initialize(sessionId, options);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
}
