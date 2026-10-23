import {
  EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  EXECUTOR_LAUNCH_RESTRICTED_MESSAGE,
  TaskStatus,
} from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTaskLaunchState,
  classifyExecutorExit,
  configureLaunchRefusedExit,
  executorExitTermination,
  isLaunchRefusal,
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
    for (const code of [0, 1, 74, 76]) {
      expect(
        classifyExecutorExit({ mode: 'templated', code, nonzeroMayHaveDispatched: false })
      ).toBe(code === 0 ? 'passive' : 'authoritative');
      expect(
        classifyExecutorExit({ mode: 'templated', code, nonzeroMayHaveDispatched: true })
      ).toBe(code === 0 ? 'passive' : 'ambiguous');
    }
  });

  it.each([null, 130, 137, 143])(
    'keeps signalled exit %s ambiguous with refusal enabled',
    (code) => {
      configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT: '75' });
      for (const nonzeroMayHaveDispatched of [false, true]) {
        expect(
          classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched })
        ).toBe('refused');
        expect(classifyExecutorExit({ mode: 'templated', code, nonzeroMayHaveDispatched })).toBe(
          'ambiguous'
        );
      }
    }
  );

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

describe('launch-restricted exit opt-in', () => {
  afterEach(() => {
    configureLaunchRefusedExit({});
    vi.restoreAllMocks();
  });

  it('reads templated exit 76 as restricted only with its own exact opt-in', () => {
    configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_RESTRICTED_EXIT: '76' });
    for (const nonzeroMayHaveDispatched of [false, true]) {
      expect(classifyExecutorExit({ mode: 'templated', code: 76, nonzeroMayHaveDispatched })).toBe(
        'restricted'
      );
    }
    expect(classifyExecutorExit({ mode: 'local', code: 76, nonzeroMayHaveDispatched: false })).toBe(
      'authoritative'
    );
    // The refused opt-in is independent: 75 stays an ordinary exit without it.
    expect(
      classifyExecutorExit({ mode: 'templated', code: 75, nonzeroMayHaveDispatched: false })
    ).toBe('authoritative');
  });

  it('keeps exit 76 an ordinary nonzero exit with only the refused opt-in', () => {
    configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT: '75' });
    expect(
      classifyExecutorExit({ mode: 'templated', code: 76, nonzeroMayHaveDispatched: true })
    ).toBe('ambiguous');
  });

  it.each(['75', '076', 'true'])('ignores the value %j with one warning', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_RESTRICTED_EXIT: value });
    expect(warn).toHaveBeenCalledOnce();
    expect(
      classifyExecutorExit({ mode: 'templated', code: 76, nonzeroMayHaveDispatched: false })
    ).toBe('authoritative');
  });

  it('treats both refusals as created-nothing', () => {
    expect(isLaunchRefusal('refused')).toBe(true);
    expect(isLaunchRefusal('restricted')).toBe(true);
    expect(isLaunchRefusal('authoritative')).toBe(false);
  });
});

describe('executorExitTermination', () => {
  it('records a refused launch with the shared message and no heartbeat loss', () => {
    expect(executorExitTermination(75, 'refused')).toEqual({
      cause: 'launch_refused',
      errorMessage: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
    });
  });

  it('records a restricted launch as a suspension stop', () => {
    expect(executorExitTermination(76, 'restricted')).toEqual({
      cause: 'tenant_suspension',
      errorMessage: EXECUTOR_LAUNCH_RESTRICTED_MESSAGE,
    });
  });

  it('keeps every other exit a lost executor', () => {
    expect(executorExitTermination(75, 'authoritative')).toEqual({
      cause: 'heartbeat_lost',
      errorMessage: 'Executor exited unexpectedly with code 75.',
    });
    expect(executorExitTermination(null, 'authoritative').errorMessage).toBe(
      'Executor exited unexpectedly with code unknown.'
    );
  });
});
