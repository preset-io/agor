import type { AgorClient, Branch, User } from '@agor-live/client';
import { Tag } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useBranchControlAccess } from '../../hooks/useBranchControlAccess';
import { formatActionError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import { REACT_FLOW_NO_DRAG_CLASS } from '../../utils/reactFlowDragClasses';
import { CompactNotice } from '../CompactNotice';
import {
  type BranchStatusInput,
  type BranchStatusTag,
  describeBranchStatus,
  getBranchStatusTag,
} from './describeBranchStatus';

export { describeBranchStatus, getBranchStatusTag } from './describeBranchStatus';

const TAG_COLOR: Record<BranchStatusTag['tone'], string> = {
  info: 'processing',
  warning: 'warning',
  error: 'error',
};

/** The vocabulary 0.2 status tag for board lists; renders nothing when the branch is ready. */
export function BranchStateTag({
  branch,
  style,
}: {
  branch: BranchStatusInput;
  style?: React.CSSProperties;
}) {
  const tag = getBranchStatusTag(branch);
  return tag ? (
    <Tag color={TAG_COLOR[tag.tone]} style={style}>
      {tag.label}
    </Tag>
  ) : null;
}

const NEEDS_ACCESS = new Set(['failed', 'preserved', 'cleaned', 'deleted']);

/** Setup, restore and deletion state for canvas cards, the teammate panel and mobile. */
export function BranchFilesystemRecovery({
  branch,
  client,
  currentUser,
  onRetryDelete,
}: {
  branch: Branch;
  client: AgorClient | null;
  currentUser?: User | null;
  /** Opens permanent deletion again; without it the deletion notice has no action. */
  onRetryDelete?: () => void;
}) {
  const message = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const [pending, setPending] = useState(false);
  const access = useBranchControlAccess(
    client,
    branch,
    currentUser,
    branch.deletion_status === 'deletion_failed' ||
      (!branch.archived && NEEDS_ACCESS.has(branch.filesystem_status ?? ''))
  );
  const notice = describeBranchStatus(branch, access);
  if (!notice) return null;

  const retry = async () => {
    if (!client) return;
    setPending(true);
    try {
      await client.service(`branches/${branch.branch_id}/retry-provisioning`).create({});
      message.showSuccess(
        notice.action === 'restore' || branch.provisioning_operation === 'restore'
          ? "Restoring the branch's files…"
          : 'Setting up the branch again…'
      );
    } catch (error) {
      message.showError(formatActionError('set up the branch again', error, { idempotent: true }));
    } finally {
      setPending(false);
    }
  };

  const action =
    notice.action === 'delete'
      ? onRetryDelete && { label: 'Try again', onClick: onRetryDelete }
      : notice.action && {
          label: notice.action === 'restore' ? 'Restore files' : 'Try again',
          onClick: () => void retry(),
          loading: pending || access === 'loading',
        };

  return (
    <CompactNotice
      className={REACT_FLOW_NO_DRAG_CLASS}
      type={notice.type}
      message={notice.message}
      detailsLead={notice.detailsLead}
      details={notice.details.length > 0 ? notice.details : undefined}
      actions={action && !(connectionDisabled || !client) ? [action] : undefined}
      role="status"
      onClick={(event) => event.stopPropagation()}
      // Offline cards block pointer events; Details and Copy stay usable (its action is hidden offline).
      style={{ marginBottom: 8, minWidth: 0, maxWidth: '100%', pointerEvents: 'auto' }}
    />
  );
}
