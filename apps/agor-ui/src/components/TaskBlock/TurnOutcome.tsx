import { type Task, TaskStatus } from '@agor/core/types';
import { Alert, theme } from 'antd';

// Exhaustive policy: new lifecycle states must choose a presentation instead of
// accidentally acquiring another floating icon. Approvals/queue own their UI.
const outcomeLabels: Record<TaskStatus, string | null> = {
  [TaskStatus.CREATED]: null,
  [TaskStatus.QUEUED]: null,
  [TaskStatus.DISPATCHING]: null,
  [TaskStatus.RUNNING]: null,
  [TaskStatus.AWAITING_PERMISSION]: null,
  [TaskStatus.AWAITING_INPUT]: null,
  [TaskStatus.COMPLETED]: null,
  [TaskStatus.STOPPING]: 'Stopping…',
  [TaskStatus.STOPPED]: 'Turn stopped',
  [TaskStatus.FAILED]: 'Turn failed',
  [TaskStatus.TIMED_OUT]: 'Turn timed out',
};

/** Exceptional outcomes belong after the response, never above the prompt or behind hover. */
export function TurnOutcome({ task }: { task: Task }) {
  const { token } = theme.useToken();
  const label =
    outcomeLabels[task.status] ?? (task.error_message ? 'Turn reported an error' : null);
  if (!label) return null;
  const type =
    task.status === TaskStatus.STOPPING
      ? 'info'
      : task.status === TaskStatus.STOPPED
        ? 'warning'
        : 'error';
  return (
    <Alert
      type={type}
      showIcon
      role={type === 'error' ? 'alert' : 'status'}
      data-turn-outcome
      title={
        task.error_message && task.error_message !== label
          ? `${label}: ${task.error_message}`
          : label
      }
      style={{ marginTop: token.marginSM, fontSize: token.fontSize, overflowWrap: 'anywhere' }}
    />
  );
}
