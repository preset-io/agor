import { describe, expect, it } from 'vitest';
import { canStartSessions } from './branchAccess';

describe('canStartSessions', () => {
  it('starts at the session level', () => {
    expect(
      ['none', 'view', 'session', 'prompt', 'all'].map((can) => canStartSessions({ can } as never))
    ).toEqual([false, false, true, true, true]);
  });
});
