import { type Task, TaskStatus } from '@agor/core/types';
import { Alert, Button, Flex, Typography } from 'antd';

/** Retry and override are deliberately separate: reopening cannot promise to stop work. */
export function RecoveryActions({
  task,
  busy,
  disconnected,
  canReopen,
  onRetry,
  onReopen,
  error,
}: {
  task?: Task;
  busy: boolean;
  disconnected: boolean;
  canReopen?: boolean;
  onRetry?: () => void;
  onReopen: () => void;
  error?: string | null;
}) {
  if (task?.status !== TaskStatus.STOPPING || task.sdk_failure?.termination !== 'unverified')
    return null;
  return (
    <Flex vertical gap="small">
      <Typography.Text>Cleanup needs attention. Try again before continuing.</Typography.Text>
      <Flex gap="small" wrap>
        <Button type="primary" onClick={onRetry} loading={busy} disabled={disconnected || busy}>
          Try again
        </Button>
        {canReopen ? (
          <Button danger onClick={onReopen} disabled={disconnected || busy}>
            Reopen anyway…
          </Button>
        ) : (
          <Typography.Text type="secondary">
            Ask the branch owner or an administrator for help if cleanup keeps failing.
          </Typography.Text>
        )}
      </Flex>
      {error && <Alert type="error" title={error} />}
    </Flex>
  );
}
