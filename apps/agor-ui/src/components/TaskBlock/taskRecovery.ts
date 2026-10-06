import { type Task, TaskStatus } from '@agor/core/types';

/** Durable recovery state, independent of transient socket/HTTP acknowledgements. */
export function taskRecoveryNotice(task: Task) {
  const unverified = task.sdk_failure?.termination === 'unverified';
  if (task.status === TaskStatus.STOPPING) {
    if (unverified)
      return {
        title: 'Cleanup needs attention',
        description:
          'Agor could not confirm that the previous work stopped. Messages already received are saved. Retry cleanup before continuing; the previous work may still be changing files.',
        type: 'warning' as const,
      };
    const cause = task.termination_request?.cause;
    return {
      title:
        cause === 'heartbeat_lost'
          ? 'Connection interrupted — recovering…'
          : cause === 'executor_interrupted'
            ? 'Work interrupted — recovering…'
            : cause === 'sdk_health_failure'
              ? 'Agent stopped responding — recovering…'
              : cause === 'authorization_revoked'
                ? 'Access changed — stopping work…'
                : 'Stopping the previous work…',
      description:
        'Agor is checking that the previous work has stopped. You do not need to stop it again. Queued prompts will wait until recovery finishes.',
      type: 'info' as const,
    };
  }
  if (task.status === TaskStatus.FAILED && unverified)
    return {
      title: 'Session reopened without confirmed cleanup',
      description:
        'The previous work was not confirmed stopped and may still change files or run commands. Reopening did not stop it.',
      type: 'warning' as const,
    };
  return null;
}
