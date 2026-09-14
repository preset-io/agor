import { TaskStatus } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import type { SessionCreationResult } from '../domain/sessionCreation';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

/** Launch confirmation, not durable queue/dispatch admission or full task completion. */
function isBootstrapTaskStarted(status: TaskStatus | undefined): boolean {
  return (
    status === TaskStatus.RUNNING ||
    status === TaskStatus.COMPLETED ||
    status === TaskStatus.AWAITING_INPUT ||
    status === TaskStatus.AWAITING_PERMISSION
  );
}

export interface StartTeammateBootstrapSessionInput<
  TSessionConfig,
  TInitialization extends SessionCreationResult,
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
  TInitialization extends SessionCreationResult,
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
  const started = initialization.initialization;
  if (
    started?.sessionId !== initialization.sessionId ||
    started.task?.session_id !== initialization.sessionId ||
    !isBootstrapTaskStarted(started.task?.status)
  )
    throw new Error(
      'First-session initialization is pending or failed. The session is saved; retry setup.'
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
  if (session.created_by !== options.expectedUserId)
    throw new Error('The retained session belongs to another caller.');
  const result = await client
    .service('tasks')
    .find({ query: { session_id: sessionId, $sort: { created_at: -1 }, $limit: 1 } });
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  const tasks = Array.isArray(result) ? result : result.data;
  if (tasks.length) {
    if (tasks.some((task) => task.session_id !== sessionId))
      throw new Error('The retained session returned unexpected task data.');
    const task = tasks[0];
    if (isBootstrapTaskStarted(task.status)) return;
    switch (task.status) {
      case TaskStatus.CREATED:
      case TaskStatus.QUEUED:
      case TaskStatus.DISPATCHING:
      case TaskStatus.STOPPING:
        throw new Error(
          'The first session is pending or stopping. Wait, then retry setup; no duplicate prompt was sent.'
        );
      case TaskStatus.FAILED:
      case TaskStatus.STOPPED:
      case TaskStatus.TIMED_OUT: {
        if (session.created_by !== options.expectedUserId || !options.prompt)
          throw new Error('Open the retained session to recover its failed first task.');
        // Retry setup is an explicit retry of the failed first turn. The normal
        // prompt route owns current authorization, containment and admission.
        const retried = await client.sessions.prompt(sessionId, options.prompt, {
          permissionMode: options.permissionMode,
        });
        if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
        if (retried.session_id !== sessionId || !isBootstrapTaskStarted(retried.status))
          throw new Error(
            'First-session recovery is pending or failed. Wait and retry setup; the retained session is saved.'
          );
        return;
      }
      default:
        throw new Error('First-session status is unknown. Reconnect before retrying setup.');
    }
  }
  const initialized = await client.sessions.initialize(sessionId, options);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  if (initialized.sessionId !== sessionId)
    throw new Error('Initialization returned an unexpected session.');
  if (
    options.prompt &&
    (initialized.task?.session_id !== sessionId ||
      !isBootstrapTaskStarted(initialized.task?.status))
  )
    throw new Error(
      'First-session initialization is pending or failed. The session is saved; retry setup.'
    );
}
