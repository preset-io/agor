import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import type { BranchControlAccess } from '../../hooks/useBranchControlAccess';
import { describeBranchStatus, getBranchStatusTag } from './describeBranchStatus';

const branch = (fields: Partial<Branch>) =>
  ({ name: 'fictional-branch', archived: false, ...fields }) as Branch;

const RESTART =
  'Branch provisioning was interrupted — the daemon restarted before it completed. Retry provisioning to try again.';

const DIRECTORY_EXISTS =
  "Directory '/home/agor/.agor/worktrees/fictional/fictional-branch' already exists and is not empty. An archived or partially-cleaned branch may still occupy this path.";

describe('getBranchStatusTag', () => {
  it.each<[string, Partial<Branch>, string | null, string | null]>([
    ['ready', { filesystem_status: 'ready' }, null, null],
    ['creating', { filesystem_status: 'creating' }, 'Setting up', 'info'],
    [
      'restoring',
      { filesystem_status: 'creating', provisioning_operation: 'restore' },
      'Restoring files',
      'info',
    ],
    ['failed', { filesystem_status: 'failed' }, 'Setup failed', 'error'],
    [
      'restore failed',
      { filesystem_status: 'failed', provisioning_operation: 'restore' },
      'Restore failed',
      'error',
    ],
    ['preserved', { filesystem_status: 'preserved' }, 'Files removed', 'warning'],
    ['cleaned', { filesystem_status: 'cleaned' }, 'Files removed', 'warning'],
    ['deleting', { deletion_status: 'deleting' }, 'Deleting', 'info'],
    ['deletion failed', { deletion_status: 'deletion_failed' }, 'Deletion failed', 'error'],
  ])('%s', (_name, fields, label, tone) => {
    const tag = getBranchStatusTag(branch(fields));
    expect(tag?.label ?? null).toBe(label);
    expect(tag?.tone ?? null).toBe(tone);
  });
});

describe('describeBranchStatus', () => {
  it.each<[string, Partial<Branch>, BranchControlAccess, string, string, string | undefined]>([
    [
      'creating',
      { filesystem_status: 'creating' },
      'allowed',
      'info',
      'Agor is setting up this branch…',
      undefined,
    ],
    [
      'restoring',
      { filesystem_status: 'creating', provisioning_operation: 'restore' },
      'allowed',
      'info',
      "Agor is restoring this branch's files…",
      undefined,
    ],
    [
      'failed',
      { filesystem_status: 'failed', error_message: 'fictional clone error' },
      'allowed',
      'error',
      "Agor couldn't set up this branch. Sessions can't start until it's set up.",
      'retry',
    ],
    [
      'failed, viewer denied',
      { filesystem_status: 'failed' },
      'denied',
      'error',
      "Agor couldn't set up this branch, so sessions can't start. Ask a branch owner or administrator to try again.",
      undefined,
    ],
    [
      'failed, access unknown',
      { filesystem_status: 'failed' },
      'unknown',
      'error',
      "Agor couldn't set up this branch. Sessions can't start until it's set up.",
      'retry',
    ],
    [
      'interrupted by a restart',
      { filesystem_status: 'failed', error_message: RESTART },
      'allowed',
      'warning',
      'Agor restarted before this branch was set up.',
      'retry',
    ],
    [
      'restore failed',
      { filesystem_status: 'failed', provisioning_operation: 'restore' },
      'allowed',
      'error',
      "Agor couldn't restore this branch's files.",
      'retry',
    ],
    [
      'restore failed, viewer denied',
      { filesystem_status: 'failed', provisioning_operation: 'restore' },
      'denied',
      'error',
      "Agor couldn't restore this branch's files. Ask a branch owner or administrator to try again.",
      undefined,
    ],
    [
      'folder already exists',
      { filesystem_status: 'failed', error_message: DIRECTORY_EXISTS },
      'allowed',
      'error',
      "Agor couldn't set up this branch. An administrator needs to clear the old folder first.",
      undefined,
    ],
    [
      'folder already exists on restore',
      {
        filesystem_status: 'failed',
        provisioning_operation: 'restore',
        error_message: DIRECTORY_EXISTS,
      },
      'allowed',
      'error',
      "Agor couldn't restore this branch's files. An administrator needs to clear the old folder first.",
      undefined,
    ],
    [
      'teammate folder already exists',
      {
        filesystem_status: 'failed',
        error_message: DIRECTORY_EXISTS,
        custom_context: { teammate: { kind: 'teammate' } },
      },
      'allowed',
      'error',
      "Agor couldn't set up your teammate's workspace. An administrator needs to clear the old folder first.",
      undefined,
    ],
    [
      'teammate failed',
      { filesystem_status: 'failed', custom_context: { teammate: { kind: 'teammate' } } },
      'allowed',
      'error',
      "Agor couldn't set up your teammate's workspace.",
      'retry',
    ],
    [
      'files removed',
      { filesystem_status: 'cleaned' },
      'allowed',
      'warning',
      "This branch's files were removed. Restore them to start a session.",
      'restore',
    ],
    [
      'files removed, viewer denied',
      { filesystem_status: 'deleted' },
      'denied',
      'warning',
      "This branch's files were removed. Ask a branch owner or administrator to restore them.",
      undefined,
    ],
    [
      'deleting',
      { deletion_status: 'deleting' },
      'allowed',
      'info',
      'Agor is deleting this branch…',
      undefined,
    ],
    [
      'deletion failed during a stage',
      {
        deletion_status: 'deletion_failed',
        deletion_error:
          'Permanent deletion failed during storage. Inspect executor logs and retry deletion.',
      },
      'allowed',
      'error',
      "Agor couldn't finish deleting this branch.",
      'delete',
    ],
    [
      'deletion never claimed',
      {
        deletion_status: 'deletion_failed',
        deletion_error:
          'Deletion dispatch was never claimed. Retry permanent deletion to fence the old dispatch and start a new invocation.',
      },
      'allowed',
      'error',
      "Agor couldn't finish deleting this branch.",
      'delete',
    ],
    [
      'deletion interrupted before admission',
      {
        deletion_status: 'deletion_failed',
        deletion_error:
          'Deletion was interrupted before executor admission. Retry permanent deletion to continue.',
      },
      'denied',
      'error',
      "Agor couldn't finish deleting this branch.",
      undefined,
    ],
    [
      'deletion lost track',
      {
        deletion_status: 'deletion_failed',
        deletion_error:
          'Deletion executor stopped reporting without a settlement acknowledgement. Retry is blocked: process exit and heartbeat age do not prove storage requests stopped. See the branch deletion recovery guide.',
      },
      'allowed',
      'warning',
      'Agor lost track of this deletion, so some files may already be gone. An administrator needs to finish it.',
      undefined,
    ],
    [
      'deletion lost track (legacy text)',
      {
        deletion_status: 'deletion_failed',
        deletion_error:
          'Deletion executor stopped reporting; its outcome is unknown. Reconciliation is required before retry.',
      },
      'allowed',
      'warning',
      'Agor lost track of this deletion, so some files may already be gone. An administrator needs to finish it.',
      undefined,
    ],
    [
      'deletion failed, other error',
      { deletion_status: 'deletion_failed', deletion_error: 'fictional error' },
      'allowed',
      'error',
      "Agor couldn't finish deleting this branch.",
      undefined,
    ],
  ])('%s', (_name, fields, access, type, message, action) => {
    const notice = describeBranchStatus(branch(fields), access);
    expect(notice?.type).toBe(type);
    expect(notice?.message).toBe(message);
    expect(notice?.action).toBe(action);
  });

  it('says once that uncommitted changes are not restored', () => {
    expect(
      describeBranchStatus(branch({ filesystem_status: 'preserved' }), 'allowed')
    ).toMatchObject({ detailsLead: "Changes that were never committed can't be brought back." });
  });

  it('keeps the raw error and the stage under Details', () => {
    const notice = describeBranchStatus(
      branch({
        deletion_status: 'deletion_failed',
        deletion_error:
          'Permanent deletion failed during storage. Inspect executor logs and retry deletion.',
      }),
      'allowed'
    );
    expect(notice?.details).toEqual([
      { label: 'Step', value: 'storage' },
      {
        label: 'Error',
        value:
          'Permanent deletion failed during storage. Inspect executor logs and retry deletion.',
        code: true,
      },
      { label: 'Branch', value: 'fictional-branch', code: true },
    ]);
  });

  it.each([
    ['ready', { filesystem_status: 'ready' }],
    ['archived', { filesystem_status: 'cleaned', archived: true }],
  ] as const)('shows nothing when %s', (_name, fields) => {
    expect(describeBranchStatus(branch(fields), 'allowed')).toBeNull();
  });
});
