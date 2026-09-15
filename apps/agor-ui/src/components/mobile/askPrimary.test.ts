import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { latestSession, resolveAskPrimaryTarget } from './askPrimary';

const session = (over: Partial<Session>): Session =>
  ({ session_id: 's', branch_id: 'b', status: 'idle', archived: false, ...over }) as Session;

describe('resolveAskPrimaryTarget', () => {
  it('continues the most-recent live session when one exists', () => {
    const target = resolveAskPrimaryTarget({ branch_id: 'b', board_id: 'bd' }, [
      session({ session_id: 'old', last_updated: '2026-01-01T00:00:00Z' }),
      session({ session_id: 'new', last_updated: '2026-02-01T00:00:00Z' }),
    ]);
    expect(target).toEqual({ kind: 'continue', sessionId: 'new' });
  });

  it('creates a fresh session on the branch when there is none', () => {
    const target = resolveAskPrimaryTarget({ branch_id: 'b', board_id: 'bd' }, []);
    expect(target).toEqual({ kind: 'create', branchId: 'b', boardId: 'bd' });
  });

  it('ignores archived sessions when choosing the target', () => {
    const target = resolveAskPrimaryTarget({ branch_id: 'b' }, [
      session({ session_id: 'archived', archived: true, last_updated: '2026-03-01T00:00:00Z' }),
    ]);
    expect(target).toEqual({ kind: 'create', branchId: 'b', boardId: '' });
  });

  it('asks the caller to pick when there is no primary teammate', () => {
    expect(resolveAskPrimaryTarget(null, [])).toEqual({ kind: 'pick' });
  });
});

describe('latestSession', () => {
  it('returns undefined when only archived sessions exist', () => {
    expect(latestSession([session({ archived: true })])).toBeUndefined();
  });
});
