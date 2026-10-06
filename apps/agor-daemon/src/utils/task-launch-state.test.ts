import { EXECUTOR_LAUNCH_REFUSED_MESSAGE, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTaskLaunchState,
  classifyExecutorExit,
  configureLaunchRefusedExit,
  executorExitTermination,
} from './task-launch-state.js';

describe('buildTaskLaunchState', () => {
  it('launches through the executor dispatch state', () => {
    expect(buildTaskLaunchState('2026-07-10T20:00:00.000Z')).toEqual({
      status: TaskStatus.DISPATCHING,
      started_at: '2026-07-10T20:00:00.000Z',
      executor_mode: 'local',
    });
  });

  it('snapshots templated execution at dispatch', () => {
    expect(buildTaskLaunchState('2026-07-10T20:00:00.000Z', 'templated')).toMatchObject({
      status: TaskStatus.DISPATCHING,
      executor_mode: 'templated',
    });
  });
});

describe('classifyExecutorExit', () => {
  it.each([
    [{ mode: 'local', code: 0, nonzeroMayHaveDispatched: false }, 'authoritative'],
    [{ mode: 'templated', code: 0, nonzeroMayHaveDispatched: false }, 'passive'],
    [{ mode: 'templated', code: 9, nonzeroMayHaveDispatched: false }, 'authoritative'],
    [{ mode: 'templated', code: 9, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: null, nonzeroMayHaveDispatched: false }, 'ambiguous'],
    [{ mode: 'templated', code: null, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: 137, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: 137, nonzeroMayHaveDispatched: false }, 'ambiguous'],
    [{ mode: 'templated', code: 143, nonzeroMayHaveDispatched: false }, 'ambiguous'],
  ] as const)('classifies %# as %s', (input, expected) => {
    expect(classifyExecutorExit(input)).toBe(expected);
  });
});

describe('launch-refused exit opt-in', () => {
  afterEach(() => {
    configureLaunchRefusedExit({});
    vi.restoreAllMocks();
  });

  it('reads templated exit 75 as refused only with the exact opt-in', () => {
    expect(configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT: '75' })).toBe(true);
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: false })
    ).toBe('refused');
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: true })
    ).toBe('refused');
    expect(classifyExecutorExit({ mode: 'local', code: 75, nonzeroMayHaveDispatched: false })).toBe(
      'authoritative'
    );
    for (const code of [0, 1, 74, 76, null]) {
      expect(
        classifyExecutorExit({ mode: 'templated', code, nonzeroMayHaveDispatched: false })
      ).toBe(code === 0 ? 'passive' : 'authoritative');
      expect(
        classifyExecutorExit({ mode: 'templated', code, nonzeroMayHaveDispatched: true })
      ).toBe(code === 0 ? 'passive' : 'ambiguous');
    }
  });

  it('keeps exit 75 an ordinary nonzero exit without the opt-in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(configureLaunchRefusedExit({})).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: false })
    ).toBe('authoritative');
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: true })
    ).toBe('ambiguous');
  });

  it.each(['1', '075', ' 75', 'true', ''])('ignores the value %j with one warning', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT: value })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: true })
    ).toBe('ambiguous');
  });
});

describe('executorExitTermination', () => {
  it('records a refused launch with the shared message and no heartbeat loss', () => {
    expect(executorExitTermination(75, true)).toEqual({
      cause: 'launch_refused',
      errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
    });
  });

  it('keeps every other exit a lost executor', () => {
    expect(executorExitTermination(75, false)).toEqual({
      cause: 'heartbeat_lost',
      errorMessage: 'Executor exited unexpectedly with code 75.',
    });
    expect(executorExitTermination(null, false).errorMessage).toBe(
      'Executor exited unexpectedly with code unknown.'
    );
  });
});
