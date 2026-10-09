import { describe, expect, it } from 'vitest';
import {
  type BranchWorkspaceOperation,
  canDismissBranchWorkspaceNotification,
} from './branch-cleanup';

describe('workspace notification versus current branch condition', () => {
  const settled = {
    workspace_operation: { status: 'failed' } as BranchWorkspaceOperation,
    filesystem_status: 'ready' as const,
    archived: false,
  };
  it.each(['succeeded', 'failed', 'accepted', 'running', 'unknown'] as const)(
    'classifies %s',
    (status) => {
      expect(
        canDismissBranchWorkspaceNotification({
          ...settled,
          workspace_operation: { ...settled.workspace_operation, status },
        })
      ).toBe(status === 'succeeded' || status === 'failed');
    }
  );
  it.each(['creating', 'failed', 'cleaned', 'preserved', 'deleted'] as const)(
    'keeps an unarchived %s workspace visible',
    (filesystem_status) => {
      expect(canDismissBranchWorkspaceNotification({ ...settled, filesystem_status })).toBe(false);
    }
  );
  it.each(['cleaned', 'preserved', 'deleted'] as const)(
    'allows an expected archived %s outcome to be forgotten',
    (filesystem_status) => {
      expect(
        canDismissBranchWorkspaceNotification({ ...settled, filesystem_status, archived: true })
      ).toBe(true);
    }
  );
  it.each(['deleting', 'deletion_failed'] as const)(
    'does not dismiss while %s',
    (deletion_status) => {
      expect(canDismissBranchWorkspaceNotification({ ...settled, deletion_status })).toBe(false);
    }
  );
  it('has nothing to dismiss without an operation', () => {
    expect(
      canDismissBranchWorkspaceNotification({ ...settled, workspace_operation: undefined })
    ).toBe(false);
  });
});
