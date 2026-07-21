import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getExecutorLiveness,
  trackExecutorProcess,
  untrackExecutorProcess,
} from './executor-tracking';

const SESSION_ID = '018f0000-0000-7000-8000-0000000000aa';

afterEach(() => {
  untrackExecutorProcess(SESSION_ID);
  vi.restoreAllMocks();
});

describe('getExecutorLiveness', () => {
  it('returns "unknown" when no PID is tracked for the session', () => {
    expect(getExecutorLiveness(SESSION_ID)).toBe('unknown');
  });

  it('returns "alive" when the tracked process exists', () => {
    trackExecutorProcess(SESSION_ID, 4242);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(getExecutorLiveness(SESSION_ID)).toBe('alive');
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it('returns "dead" when the tracked process no longer exists (ESRCH)', () => {
    trackExecutorProcess(SESSION_ID, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(getExecutorLiveness(SESSION_ID)).toBe('dead');
  });

  it('treats EPERM as "alive" (process owned by another Unix user)', () => {
    trackExecutorProcess(SESSION_ID, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(getExecutorLiveness(SESSION_ID)).toBe('alive');
  });
});
