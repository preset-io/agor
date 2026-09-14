import type { Branch } from '@agor-live/client';
import { projectBranchWorkspaceOperation } from '@agor-live/client';
import { Alert } from 'antd';
import { useEffect, useState } from 'react';

/** Shared status read model; no browser timer ever releases server maintenance. */
export function BranchWorkspaceStatus({ branch }: { branch: Branch }) {
  const [now, setNow] = useState(Date.now);
  const operation = branch.workspace_operation;
  useEffect(() => {
    if (!operation || !['accepted', 'running'].includes(operation.status)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(operation.deadline_at) - Date.now()) + 1
    );
    return () => clearTimeout(timer);
  }, [operation]);
  const current = projectBranchWorkspaceOperation(operation, now);
  if (!current) return null;
  const label =
    current.action === 'clean' || current.filesystem_action === 'cleaned'
      ? 'Branch cleanup'
      : 'Archive workspace';
  const previous =
    branch.cleanup_last_error?.operation_id !== current.operation_id
      ? branch.cleanup_last_error
      : undefined;
  return (
    <Alert
      showIcon
      type={
        current.status === 'failed' || current.status === 'unknown'
          ? 'error'
          : current.status === 'succeeded'
            ? 'success'
            : 'info'
      }
      description={
        <>
          <div>
            {label}: {current.status}. {current.error}
          </div>
          <div>{current.finished_at || current.started_at || current.requested_at}</div>
          {previous && current.status !== 'succeeded' && (
            <div>
              Previous cleanup error ({previous.at}): {previous.message}
            </div>
          )}
        </>
      }
    />
  );
}
