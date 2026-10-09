import { ENVIRONMENT_COMMAND_BUDGET } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchEnvironmentCommand,
  ExecutorLaunchRefusedError,
} from './environment-command-dispatch';
import { requestExecutor, spawnExecutor } from './spawn-executor';
import { configureLaunchRefusedExit } from './task-launch-state';

vi.mock('./spawn-executor', () => ({ spawnExecutor: vi.fn(), requestExecutor: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  configureLaunchRefusedExit({});
});
describe('fire-and-forget environment launcher handoff', () => {
  it('returns on launcher acceptance with no executor claim/result and no response waiter', async () => {
    vi.mocked(spawnExecutor).mockImplementation((_payload, options) => {
      void options?.onExit?.(0, { mode: 'templated' });
    });
    const payload = { command: 'environment.lifecycle' };
    await expect(dispatchEnvironmentCommand(payload, {})).resolves.toBeUndefined();
    expect(requestExecutor).not.toHaveBeenCalled();
    expect(spawnExecutor).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ launcherProcessGroup: true })
    );
    expect(payload).not.toHaveProperty('executorResponse');
  });
  it('allows slow admission beyond ten seconds without waiting for executor startup', async () => {
    vi.useFakeTimers();
    let accepted = false;
    const pending = dispatchEnvironmentCommand({ command: 'environment.lifecycle' }, {}).then(
      () => {
        accepted = true;
      }
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(accepted).toBe(false);
    const options = vi.mocked(spawnExecutor).mock.calls[0]![1];
    void options?.onExit?.(0, { mode: 'templated' });
    await pending;
    expect(accepted).toBe(true);
    expect(ENVIRONMENT_COMMAND_BUDGET.launchMs).toBe(30_000);
  });
  it('bounds a hung launcher and reports nonzero handoff honestly', async () => {
    vi.useFakeTimers();
    const pending = expect(
      dispatchEnvironmentCommand({ command: 'environment.lifecycle' }, {})
    ).rejects.toThrow('outcome unknown');
    await vi.advanceTimersByTimeAsync(ENVIRONMENT_COMMAND_BUDGET.launchMs);
    await pending;
    vi.mocked(spawnExecutor).mockImplementation((_payload, options) => {
      void options?.onExit?.(1, { mode: 'templated' });
    });
    await expect(dispatchEnvironmentCommand({}, {})).rejects.toThrow('outcome unknown');
  });
  it('reports an opted-in launcher refusal as a refused launch, not an unknown outcome', async () => {
    configureLaunchRefusedExit({ AGOR_EXECUTOR_LAUNCH_REFUSED_EXIT: '75' });
    vi.mocked(spawnExecutor).mockImplementation((_payload, options) => {
      void options?.onExit?.(75, { mode: 'templated' });
    });
    await expect(
      dispatchEnvironmentCommand({ command: 'environment.lifecycle' }, {})
    ).rejects.toBeInstanceOf(ExecutorLaunchRefusedError);
    vi.mocked(spawnExecutor).mockImplementation((_payload, options) => {
      void options?.onExit?.(1, { mode: 'templated' });
    });
    await expect(dispatchEnvironmentCommand({}, {})).rejects.toThrow('outcome unknown');
  });
  it('keeps exit 75 an unknown outcome without the launcher opt-in', async () => {
    vi.mocked(spawnExecutor).mockImplementation((_payload, options) => {
      void options?.onExit?.(75, { mode: 'templated' });
    });
    const failure = dispatchEnvironmentCommand({ command: 'environment.lifecycle' }, {});
    await expect(failure).rejects.toThrow('outcome unknown');
    await expect(failure).rejects.not.toBeInstanceOf(ExecutorLaunchRefusedError);
  });
});
