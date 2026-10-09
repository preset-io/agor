import type { AgorClient, Branch, EffectiveBranchAccess, User } from '@agor-live/client';
import {
  BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE,
  canDismissBranchWorkspaceNotification,
  projectBranchWorkspaceOperation,
} from '@agor-live/client';
import { CloseOutlined } from '@ant-design/icons';
import { Alert, Button, Spin, Tooltip, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '../utils/message';
import { REACT_FLOW_NO_DRAG_CLASS } from '../utils/reactFlowDragClasses';

/** A single workspace outcome, not an activity log. Dismissal never releases maintenance. */
export function BranchWorkspaceStatus({
  branch,
  client = null,
  currentUser,
  detailed = false,
}: {
  branch: Branch;
  client?: AgorClient | null;
  currentUser?: User | null;
  detailed?: boolean;
}) {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
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
  const dismissible = canDismissBranchWorkspaceNotification(branch);
  const authority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );
  const guard = useAuthorityOperationGuard(
    authority.operationScope
      ? [...authority.operationScope, branch.branch_id, current?.operation_id, current?.status]
      : null
  );
  const [managementScope, setManagementScope] = useState<typeof guard | null>(null);
  const [pendingScope, setPendingScope] = useState<typeof guard | null>(null);
  const [dismissedScope, setDismissedScope] = useState<typeof guard | null>(null);
  const pending = pendingScope === guard;

  // Only cards with a settled notification need this permission read. The
  // server rechecks Manager authority and settlement atomically at dismissal.
  useEffect(() => {
    setManagementScope(null);
    if (!client || !dismissible) return;
    const request = guard.begin();
    if (!request.isCurrent()) return;
    void client
      .service('branches/:id/effective-access')
      .find({ route: { id: branch.branch_id } })
      .then((result) => {
        const access = result as unknown as EffectiveBranchAccess;
        if (request.isCurrent() && (access.is_owner || access.can === 'all'))
          setManagementScope(guard);
      })
      .catch(() => {
        /* Permission reads fail closed; the status remains readable. */
      });
    return () => request.cancel();
  }, [branch.branch_id, client, dismissible, guard]);

  const dismiss = async () => {
    if (!client || !current || !dismissible || managementScope !== guard || pending) return;
    const request = guard.begin();
    if (!request.isCurrent()) return;
    setPendingScope(guard);
    try {
      await client
        .service(BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE)
        .create({ operation_id: current.operation_id }, { route: { id: branch.branch_id } });
      // Hide only AFTER persisted acknowledgement. Other surfaces receive the
      // canonical branch patch; this also covers a modal holding a snapshot.
      if (request.isCurrent()) setDismissedScope(guard);
    } catch (error) {
      if (request.isCurrent())
        showError(
          error instanceof Error ? error.message : 'Could not dismiss workspace notification'
        );
    } finally {
      if (request.isCurrent()) setPendingScope(null);
    }
  };

  if (!current || dismissedScope === guard) return null;
  const label =
    current.action === 'clean' || current.filesystem_action === 'cleaned'
      ? 'Branch cleanup'
      : 'Archive workspace';
  const statusLabel = {
    accepted: 'queued',
    running: 'in progress',
    succeeded: 'completed',
    failed: 'failed',
    unknown: 'needs attention',
  }[current.status];
  const timestamp = current.finished_at || current.started_at || current.requested_at;
  const inProgress = current.status === 'accepted' || current.status === 'running';
  return (
    <Alert
      className={REACT_FLOW_NO_DRAG_CLASS}
      showIcon
      style={{ marginBottom: detailed ? undefined : token.marginSM }}
      icon={inProgress ? <Spin size="small" /> : undefined}
      styles={{ section: { minWidth: 0 } }}
      type={
        current.status === 'failed' || current.status === 'unknown'
          ? 'error'
          : current.status === 'succeeded'
            ? 'success'
            : 'info'
      }
      title={<Tooltip title={timestamp}>{`${label} ${statusLabel}`}</Tooltip>}
      description={
        current.error && (
          <Typography.Paragraph
            style={{ marginBottom: 0, overflowWrap: 'anywhere' }}
            ellipsis={detailed ? false : { rows: 2, expandable: true, symbol: 'Show details' }}
          >
            {current.error}
          </Typography.Paragraph>
        )
      }
      action={
        dismissible &&
        managementScope === guard && (
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            loading={pending}
            disabled={pending || !authority.connectionReady}
            aria-label="Dismiss notification for everyone"
            title="Dismiss notification for everyone"
            style={{ color: token.colorTextSecondary }}
            onClick={(event) => {
              event.stopPropagation();
              void dismiss();
            }}
          />
        )
      }
    />
  );
}
