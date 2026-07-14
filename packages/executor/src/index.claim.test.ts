import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectExecutor: vi.fn(),
  tryMarkTaskTerminal: vi.fn(),
}));

vi.mock('@agor/core/utils/logger', () => ({ patchConsole: vi.fn() }));
vi.mock('./services/feathers-client.js', () => ({
  createFeathersClient: vi.fn(async () => ({
    service: vi.fn(() => ({ connectExecutor: mocks.connectExecutor })),
  })),
}));
vi.mock('./terminal-task.js', () => ({ tryMarkTaskTerminal: mocks.tryMarkTaskTerminal }));

import { AgorExecutor } from './index.js';

describe('AgorExecutor claim ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not fail a task when another process already owns the claim', async () => {
    mocks.connectExecutor.mockRejectedValueOnce(new Error('claim conflict'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      executorAttemptId: 'attempt-1',
      prompt: 'test',
      tool: 'claude-code',
      daemonUrl: 'http://localhost:3001',
    });

    await executor.start();

    expect(mocks.tryMarkTaskTerminal).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
