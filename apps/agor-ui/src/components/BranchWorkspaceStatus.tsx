import type { AgorClient, Branch, EffectiveBranchAccess, User } from '@agor-live/client';
import {
  BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE,
  canDismissBranchWorkspaceNotification,
  projectBranchWorkspaceOperation,
} from '@agor-live/client';
import { Tooltip, theme } from 'antd';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../hooks/useAuthorityOperationGuard';
import { formatActionError } from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';
import { REACT_FLOW_NO_DRAG_CLASS } from '../utils/reactFlowDragClasses';
import { CompactNotice, type CompactNoticeType } from './CompactNotice';

type WorkspaceOperation = NonNullable<ReturnType<typeof projectBranchWorkspaceOperation>>;

const WORKSPACE_COPY = {
  clean: {
    accepted: "Agor is cleaning up this branch's files…",
    failed: "Agor couldn't clean up this branch's files.",
    unknown: 'Agor lost track of this cleanup, so some files may already be gone.',
    succeeded: 'Cleanup finished.',
  },
  archive: {
    accepted: 'Agor is archiving this branch…',
    failed: "Agor couldn't archive this branch's files.",
    unknown: 'Agor lost track of this archive, so some files may already be gone.',
    succeeded: 'Branch archived.',
  },
} as const;

/** `unknown` covers an executor that reported no outcome and a run past its deadline. */
export function describeWorkspaceOperation(operation: WorkspaceOperation): {
  type: CompactNoticeType;
  message: string;
} {
  const copy = WORKSPACE_COPY[operation.action];
  switch (operation.status) {
    case 'accepted':
    case 'running':
      return { type: 'info', message: copy.accepted };
    case 'failed':
      return { type: 'error', message: copy.failed };
    case 'unknown':
      return { type: 'warning', message: copy.unknown };
    case 'succeeded':
      return { type: 'neutral', message: copy.succeeded };
  }
}

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
        showError(formatActionError('dismiss the notification', error, { idempotent: true }));
    } finally {
      if (request.isCurrent()) setPendingScope(null);
    }
  };

  if (!current || dismissedScope === guard) return null;
  const notice = describeWorkspaceOperation(current);
  const timestamp = current.finished_at || current.started_at || current.requested_at;
  const canDismiss = dismissible && managementScope === guard && authority.connectionReady;
  return (
    <CompactNotice
      className={REACT_FLOW_NO_DRAG_CLASS}
      type={notice.type}
      message={<Tooltip title={timestamp}>{notice.message}</Tooltip>}
      details={
        current.error
          ? [
              { label: 'Error', value: current.error, code: true },
              { label: 'Branch', value: branch.name, code: true },
            ]
          : undefined
      }
      actions={
        canDismiss
          ? [{ label: 'Dismiss', onClick: () => void dismiss(), loading: pending }]
          : undefined
      }
      role="status"
      onClick={(event) => event.stopPropagation()}
      // Offline cards block pointer events; Details and Copy stay usable (Dismiss is hidden offline).
      style={{
        marginBottom: detailed ? undefined : token.marginSM,
        minWidth: 0,
        maxWidth: '100%',
        pointerEvents: 'auto',
      }}
    />
  );
}
