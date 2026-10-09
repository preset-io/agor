import { classifyBranchFilesystemReadiness, isTeammate } from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import type { BranchControlAccess } from '../../hooks/useBranchControlAccess';
import type { CompactNoticeDetail, CompactNoticeType } from '../CompactNotice';

/** Exact server text from repos.ts when a restart interrupts provisioning. */
const PROVISIONING_RESTART_MESSAGE =
  'Branch provisioning was interrupted — the daemon restarted before it completed. Retry provisioning to try again.';
/** Executor text when the checkout folder is occupied; trying again hits the same folder. */
const DIRECTORY_EXISTS =
  /^Directory '.+' already exists and is not empty\. An archived or partially-cleaned branch may still occupy this path\.$/;
/** Covers the current "without a settlement acknowledgement" text and the legacy "outcome is unknown" one. */
const DELETION_LOST_TRACK_PREFIX = 'Deletion executor stopped reporting';
const RETRYABLE_DELETION_PREFIXES = [
  'Permanent deletion failed during ',
  'Deletion dispatch was never claimed.',
  'Deletion was interrupted before executor admission.',
];
const DELETION_STAGE = /^Permanent deletion failed during (\w+)\./;

export const ASK_TO_TRY_AGAIN = 'Ask a branch owner or administrator to try again.';

export type BranchStatusTag = { label: string; tone: 'info' | 'warning' | 'error' };

export interface BranchStatusNotice {
  type: CompactNoticeType;
  message: string;
  /** `retry` and `restore` call retry-provisioning; `delete` reopens permanent deletion. */
  action?: 'retry' | 'restore' | 'delete';
  detailsLead?: string;
  details: CompactNoticeDetail[];
}

export type BranchStatusInput = Pick<
  Branch,
  | 'name'
  | 'archived'
  | 'filesystem_status'
  | 'deletion_status'
  | 'deletion_error'
  | 'error_message'
  | 'provisioning_operation'
> &
  Partial<Pick<Branch, 'custom_context'>>;

/** The P4 tag for a branch's filesystem or deletion state; none when it's ready or unknown. */
export function getBranchStatusTag(branch: BranchStatusInput): BranchStatusTag | null {
  if (branch.deletion_status === 'deleting') return { label: 'Deleting', tone: 'info' };
  if (branch.deletion_status === 'deletion_failed')
    return { label: 'Deletion failed', tone: 'error' };
  if (branch.archived) return null;
  switch (classifyBranchFilesystemReadiness(branch)) {
    case 'pending':
      return branch.provisioning_operation === 'restore'
        ? { label: 'Restoring files', tone: 'info' }
        : { label: 'Setting up', tone: 'info' };
    case 'failed':
      return branch.provisioning_operation === 'restore'
        ? { label: 'Restore failed', tone: 'error' }
        : { label: 'Setup failed', tone: 'error' };
    case 'unavailable':
      return { label: 'Files removed', tone: 'warning' };
    default:
      return null;
  }
}

function errorDetails(branch: BranchStatusInput, error: string | undefined): CompactNoticeDetail[] {
  return [
    ...(error ? [{ label: 'Error', value: error, code: true }] : []),
    { label: 'Branch', value: branch.name, code: true },
  ];
}

function describeDeletion(
  branch: BranchStatusInput,
  access: BranchControlAccess
): BranchStatusNotice {
  if (branch.deletion_status === 'deleting') {
    return { type: 'info', message: 'Agor is deleting this branch…', details: [] };
  }
  const error = branch.deletion_error;
  if (error?.startsWith(DELETION_LOST_TRACK_PREFIX)) {
    return {
      type: 'warning',
      message:
        'Agor lost track of this deletion, so some files may already be gone. An administrator needs to finish it.',
      details: errorDetails(branch, error),
    };
  }
  const retryable = RETRYABLE_DELETION_PREFIXES.some((prefix) => error?.startsWith(prefix));
  const stage = error?.match(DELETION_STAGE)?.[1];
  return {
    type: 'error',
    message: "Agor couldn't finish deleting this branch.",
    action: retryable && access !== 'denied' ? 'delete' : undefined,
    details: [...(stage ? [{ label: 'Step', value: stage }] : []), ...errorDetails(branch, error)],
  };
}

/** One notice per branch state for the card, the teammate panel, the archive modal and mobile. */
export function describeBranchStatus(
  branch: BranchStatusInput,
  access: BranchControlAccess
): BranchStatusNotice | null {
  if (branch.deletion_status) return describeDeletion(branch, access);
  if (branch.archived) return null;
  const denied = access === 'denied';
  const details = errorDetails(branch, branch.error_message);
  switch (classifyBranchFilesystemReadiness(branch)) {
    case 'pending':
      return {
        type: 'info',
        message:
          branch.provisioning_operation === 'restore'
            ? "Agor is restoring this branch's files…"
            : 'Agor is setting up this branch…',
        details: [],
      };
    case 'failed':
      if (branch.error_message === PROVISIONING_RESTART_MESSAGE) {
        return {
          type: 'warning',
          message: denied
            ? `Agor restarted before this branch was set up. ${ASK_TO_TRY_AGAIN}`
            : 'Agor restarted before this branch was set up.',
          action: denied ? undefined : 'retry',
          details,
        };
      }
      if (DIRECTORY_EXISTS.test(branch.error_message ?? '')) {
        const lead =
          branch.provisioning_operation === 'restore'
            ? "Agor couldn't restore this branch's files."
            : isTeammate(branch)
              ? "Agor couldn't set up your teammate's workspace."
              : "Agor couldn't set up this branch.";
        return {
          type: 'error',
          message: `${lead} An administrator needs to clear the old folder first.`,
          details,
        };
      }
      if (branch.provisioning_operation === 'restore') {
        return {
          type: 'error',
          message: denied
            ? `Agor couldn't restore this branch's files. ${ASK_TO_TRY_AGAIN}`
            : "Agor couldn't restore this branch's files.",
          action: denied ? undefined : 'retry',
          details,
        };
      }
      if (isTeammate(branch)) {
        return denied
          ? {
              type: 'error',
              message: `Agor couldn't set up your teammate's workspace. ${ASK_TO_TRY_AGAIN}`,
              details,
            }
          : {
              type: 'error',
              message: "Agor couldn't set up your teammate's workspace.",
              action: 'retry',
              detailsLead: "Try again here. You don't need to create another teammate.",
              details,
            };
      }
      return {
        type: 'error',
        message: denied
          ? `Agor couldn't set up this branch, so sessions can't start. ${ASK_TO_TRY_AGAIN}`
          : "Agor couldn't set up this branch. Sessions can't start until it's set up.",
        action: denied ? undefined : 'retry',
        details,
      };
    case 'unavailable':
      return {
        type: 'warning',
        message: denied
          ? "This branch's files were removed. Ask a branch owner or administrator to restore them."
          : "This branch's files were removed. Restore them to start a session.",
        action: denied ? undefined : 'restore',
        detailsLead: "Changes that were never committed can't be brought back.",
        details,
      };
    default:
      return null;
  }
}
