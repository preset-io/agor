import { describe, expect, it, vi } from 'vitest';
import { AgorExecutor, type ExecutorConfig } from './index';

type TestExecutor = AgorExecutor & {
  client: {
    service(name: 'tasks'): {
      get: ReturnType<typeof vi.fn>;
      patch: ReturnType<typeof vi.fn>;
    };
  };
  emitExecutorConnected(): Promise<void>;
};

function executorWithTasksService(tasksService: {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
}): TestExecutor {
  const config: ExecutorConfig = {
    sessionToken: 'token-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    prompt: 'hello',
    tool: 'codex',
    daemonUrl: 'http://daemon.test',
  };
  const executor = new AgorExecutor(config) as unknown as TestExecutor;
  executor.client = {
    service(name: 'tasks') {
      if (name !== 'tasks') throw new Error(`unexpected service ${name}`);
      return tasksService;
    },
  };
  return executor;
}

describe('AgorExecutor emitExecutorConnected', () => {
  it('fails fast when the daemon ignores the executor-connected patch', async () => {
    const executor = executorWithTasksService({
      get: vi.fn().mockResolvedValue({ runtime_vitals: undefined }),
      patch: vi.fn().mockResolvedValue({ runtime_patch_ignored: true }),
    });

    await expect(executor.emitExecutorConnected()).rejects.toThrow(
      /Failed to claim executor attempt: Executor attempt is no longer current/
    );
  });

  it('fails fast when the executor-connected patch is not written', async () => {
    const executor = executorWithTasksService({
      get: vi.fn().mockResolvedValue({ runtime_vitals: undefined }),
      patch: vi.fn().mockRejectedValue(new Error('socket disconnected')),
    });

    await expect(executor.emitExecutorConnected()).rejects.toThrow(
      /Failed to claim executor attempt: Failed to write executor_connected runtime event/
    );
  });
});
