import { classifyBranchFilesystemReadiness, isTeammate } from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import type { BranchControlAccess } from '../../utils/branchAccess';
import type { CompactNoticeDetail, CompactNoticeType } from '../CompactNotice';

/** Executor text when the checkout folder is occupied, often by a branch whose cleanup hasn't finished. */
const DIRECTORY_EXISTS = 'already exists and is not empty';
/** Covers the current "without a settlement acknowledgement" text and the legacy "outcome is unknown" one. */
const DELETION_LOST_TRACK_PREFIX = 'Deletion executor stopped reporting';

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

/** The tag for a branch's filesystem or deletion state; none when it's ready or unknown. */
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
      return { label: 'Files unavailable', tone: 'warning' };
    default:
      return null;
  }
}

/** Whether this state's notice offers an action that depends on the viewer's access. */
export function needsBranchAccess(branch: BranchStatusInput): boolean {
  if (branch.deletion_status)
    return (
      branch.deletion_status === 'deletion_failed' &&
      !branch.deletion_error?.startsWith(DELETION_LOST_TRACK_PREFIX)
    );
  if (branch.archived) return false;
  const readiness = classifyBranchFilesystemReadiness(branch);
  return readiness === 'failed' || readiness === 'unavailable';
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
  return {
    type: 'error',
    message: "Agor couldn't finish deleting this branch.",
    action: access === 'denied' ? undefined : 'delete',
    details: errorDetails(branch, error),
  };
}

function failedLead(branch: BranchStatusInput): string {
  if (branch.provisioning_operation === 'restore')
    return "Agor couldn't restore this branch's files";
  if (isTeammate(branch)) return "Agor couldn't set up your teammate's workspace";
  return "Agor couldn't set up this branch";
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
    case 'failed': {
      const setup = branch.provisioning_operation !== 'restore';
      const teammate = setup && isTeammate(branch);
      const inUse = branch.error_message?.includes(DIRECTORY_EXISTS);
      const first = `${failedLead(branch)}${inUse ? ', because its folder is still in use.' : '.'}`;
      const second = denied
        ? ASK_TO_TRY_AGAIN
        : setup && !teammate && !inUse
          ? "Sessions can't start until it's set up."
          : undefined;
      return {
        type: 'error',
        message: second ? `${first} ${second}` : first,
        action: denied ? undefined : 'retry',
        detailsLead:
          teammate && !denied
            ? "Try again here. You don't need to create another teammate."
            : undefined,
        details,
      };
    }
    case 'unavailable':
      return {
        type: 'warning',
        message: denied
          ? "This branch's files aren't available. Ask a branch owner or administrator to restore them."
          : "This branch's files aren't available. Restore them to start a session.",
        action: denied ? undefined : 'restore',
        detailsLead:
          branch.filesystem_status === 'deleted'
            ? "Changes that were never committed can't be brought back."
            : undefined,
        details,
      };
    default:
      return null;
  }
}
