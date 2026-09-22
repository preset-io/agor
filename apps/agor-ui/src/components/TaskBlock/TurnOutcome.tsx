import { type Task, TaskStatus } from '@agor/core/types';
import { ClockCircleOutlined, CloseCircleOutlined, StopOutlined } from '@ant-design/icons';
import { Flex, theme } from 'antd';

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
  const failed = task.status === TaskStatus.FAILED || task.status === TaskStatus.TIMED_OUT;
  const label =
    outcomeLabels[task.status] ?? (task.error_message ? 'Turn reported an error' : null);
  if (!label) return null;
  const error = failed || !!task.error_message;
  return (
    <Flex
      vertical
      gap={token.sizeUnit}
      role={error ? 'alert' : 'status'}
      data-turn-outcome
      style={{
        marginTop: token.marginSM,
        marginInlineStart: 32 + token.marginSM,
        fontSize: token.fontSizeSM,
        color: error ? token.colorErrorText : token.colorTextSecondary,
        overflowWrap: 'anywhere',
      }}
    >
      <Flex align="center" gap={token.sizeUnit}>
        {task.status === TaskStatus.TIMED_OUT ? (
          <ClockCircleOutlined aria-hidden />
        ) : error ? (
          <CloseCircleOutlined aria-hidden />
        ) : (
          <StopOutlined aria-hidden />
        )}
        <span>{label}</span>
      </Flex>
      {task.error_message && task.error_message !== label && <span>{task.error_message}</span>}
    </Flex>
  );
}
