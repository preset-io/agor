import { ENVIRONMENT_COMMAND_BUDGET } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchEnvironmentCommand } from './environment-command-dispatch';
import { requestExecutor, spawnExecutor } from './spawn-executor';

vi.mock('./spawn-executor', () => ({ spawnExecutor: vi.fn(), requestExecutor: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
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
});
