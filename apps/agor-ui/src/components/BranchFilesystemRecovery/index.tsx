import { classifyBranchFilesystemReadiness } from '@agor/core/types';
import type { AgorClient, Branch } from '@agor-live/client';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button } from 'antd';
import { useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useThemedMessage } from '../../utils/message';
import { REACT_FLOW_NO_DRAG_CLASS } from '../../utils/reactFlowDragClasses';

/** Both canvas cards and the separate board-primary panel use this recovery owner. */
export function BranchFilesystemRecovery({
  branch,
  client,
}: {
  branch: Branch;
  client: AgorClient | null;
}) {
  const message = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const [pending, setPending] = useState(false);
  const readiness = classifyBranchFilesystemReadiness(branch);
  if (branch.archived || branch.deletion_status || readiness === 'ready') return null;
  const creating = readiness === 'pending';
  const retry = async () => {
    if (!client) return;
    setPending(true);
    try {
      await client.service(`branches/${branch.branch_id}/retry-provisioning`).create({});
      message.showSuccess('Provisioning retry requested');
    } catch (error) {
      message.showError(
        error instanceof Error ? error.message : 'Failed to retry branch provisioning'
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Alert
      className={REACT_FLOW_NO_DRAG_CLASS}
      style={{ marginBottom: 8 }}
      type={creating ? 'info' : 'error'}
      title={
        creating
          ? branch.provisioning_operation === 'restore'
            ? 'Filesystem recovery in progress'
            : 'Filesystem provisioning in progress'
          : readiness === 'failed'
            ? 'Provisioning failed'
            : 'Filesystem unavailable'
      }
      description={branch.error_message}
      action={
        !creating && (
          <Button
            aria-label={readiness === 'failed' ? 'Retry' : 'Recover'}
            size="small"
            danger
            icon={<ReloadOutlined />}
            loading={pending}
            disabled={!client || connectionDisabled}
            onClick={(event) => {
              event.stopPropagation();
              void retry();
            }}
          >
            {readiness === 'failed' ? 'Retry' : 'Recover'}
          </Button>
        )
      }
    />
  );
}
