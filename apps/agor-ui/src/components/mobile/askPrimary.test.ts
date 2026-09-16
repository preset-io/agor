import { describe, expect, it } from 'vitest';
import { resolveAskPrimaryTarget } from './askPrimary';

describe('resolveAskPrimaryTarget', () => {
  it('always creates a fresh session on the primary branch', () => {
    expect(resolveAskPrimaryTarget({ branch_id: 'b', board_id: 'bd' })).toEqual({
      kind: 'create',
      branchId: 'b',
      boardId: 'bd',
    });
  });

  it('defaults the board id to empty when the branch has none', () => {
    expect(resolveAskPrimaryTarget({ branch_id: 'b' })).toEqual({
      kind: 'create',
      branchId: 'b',
      boardId: '',
    });
  });

  it('asks the caller to pick when there is no primary teammate', () => {
    expect(resolveAskPrimaryTarget(null)).toEqual({ kind: 'pick' });
  });
});
