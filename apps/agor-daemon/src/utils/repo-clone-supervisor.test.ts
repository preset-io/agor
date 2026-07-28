import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRepoCloneTimeoutError,
  type RepoCloneTimeoutContext,
  superviseRepoClone,
} from './repo-clone-supervisor.js';
import type { ExecutorExitResult, ExecutorProcessHandle } from './spawn-executor.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function exit(code: number | null = 0): ExecutorExitResult {
  return { mode: 'local', code, signal: null };
}

function fakeProcess(options: {
  completion: Promise<ExecutorExitResult>;
  terminate?: () => Promise<void>;
}): ExecutorProcessHandle {
  return {
    context: { mode: 'local' },
    completion: options.completion,
    terminate: options.terminate ?? vi.fn(async () => undefined),
  };
}

const tempPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    tempPaths.splice(0).map((tempPath) => rm(tempPath, { recursive: true, force: true }))
  );
});

describe('superviseRepoClone', () => {
  it('preserves a successful clone without cleanup or timeout persistence', async () => {
    const processCompletion = deferred<ExecutorExitResult>();
    const cleanupPartialClone = vi.fn(async () => undefined);
    const onExit = vi.fn(async () => undefined);
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    const supervisor = superviseRepoClone({
      process: fakeProcess({ completion: processCompletion.promise }),
      timeoutMs: 100,
      cleanupPartialClone,
      onExit,
      onTimeout,
    });

    processCompletion.resolve(exit(0));

    await expect(supervisor.completion).resolves.toBe('exited');
    expect(onExit).toHaveBeenCalledWith(exit(0));
    expect(cleanupPartialClone).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('preserves ordinary clone failure handling without timeout cleanup', async () => {
    const cleanupPartialClone = vi.fn(async () => undefined);
    const onExit = vi.fn(async () => undefined);
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    let allowTreeTermination!: () => void;
    const terminate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          allowTreeTermination = resolve;
        })
    );
    const supervisor = superviseRepoClone({
      process: fakeProcess({ completion: Promise.resolve(exit(128)), terminate }),
      timeoutMs: 100,
      cleanupPartialClone,
      onExit,
      onTimeout,
    });

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(onExit).not.toHaveBeenCalled();
    allowTreeTermination();

    await expect(supervisor.completion).resolves.toBe('exited');
    expect(onExit).toHaveBeenCalledWith(exit(128));
    expect(cleanupPartialClone).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('awaits process-tree termination before removing a partial checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agor-clone-timeout-'));
    tempPaths.push(root);
    const partialCheckout = path.join(root, 'partial');
    await mkdir(partialCheckout);

    const processCompletion = deferred<ExecutorExitResult>();
    const terminationAllowed = deferred<void>();
    const order: string[] = [];
    const process = fakeProcess({
      completion: processCompletion.promise,
      terminate: vi.fn(async () => {
        order.push('terminate:start');
        await terminationAllowed.promise;
        order.push('terminate:done');
        processCompletion.resolve({ mode: 'local', code: null, signal: 'SIGKILL' });
      }),
    });
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => {
      order.push('persist');
    });
    const supervisor = superviseRepoClone({
      process,
      timeoutMs: 10,
      cleanupPartialClone: async () => {
        order.push('cleanup');
        const { rm } = await import('node:fs/promises');
        await rm(partialCheckout, { recursive: true });
      },
      onExit: vi.fn(async () => undefined),
      onTimeout,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['terminate:start']);
    await expect(stat(partialCheckout)).resolves.toBeDefined();

    terminationAllowed.resolve();
    await expect(supervisor.completion).resolves.toBe('timed_out');
    expect(order).toEqual(['terminate:start', 'terminate:done', 'cleanup', 'persist']);
    await expect(stat(partialCheckout)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(onTimeout.mock.calls[0]?.[0].error).toMatchObject({
      exit_code: 124,
      category: 'timeout',
    });
  });

  it('persists timeout classification and cleanup failure truthfully', async () => {
    const processCompletion = deferred<ExecutorExitResult>();
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    const supervisor = superviseRepoClone({
      process: fakeProcess({
        completion: processCompletion.promise,
        terminate: async () => {
          processCompletion.resolve({ mode: 'local', code: null, signal: 'SIGTERM' });
        },
      }),
      timeoutMs: 5,
      cleanupPartialClone: async () => {
        throw new Error('permission denied');
      },
      onExit: vi.fn(async () => undefined),
      onTimeout,
    });

    await expect(supervisor.completion).resolves.toBe('timed_out');
    expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({
      cleanupError: 'permission denied',
      error: {
        exit_code: 124,
        category: 'timeout',
        message: expect.stringMatching(/cleanup failed.*permission denied/i),
      },
    });
  });

  it('does not let late process completion run normal exit handling after timeout wins', async () => {
    const processCompletion = deferred<ExecutorExitResult>();
    const onExit = vi.fn(async () => undefined);
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    const supervisor = superviseRepoClone({
      process: fakeProcess({
        completion: processCompletion.promise,
        terminate: async () => undefined,
      }),
      timeoutMs: 5,
      cleanupPartialClone: async () => undefined,
      onExit,
      onTimeout,
    });

    await expect(supervisor.completion).resolves.toBe('timed_out');
    processCompletion.resolve(exit(0));
    await Promise.resolve();

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('preserves explicit cancellation without classifying it as timeout', async () => {
    const processCompletion = deferred<ExecutorExitResult>();
    const cleanupPartialClone = vi.fn(async () => undefined);
    const onExit = vi.fn(async () => undefined);
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    const supervisor = superviseRepoClone({
      process: fakeProcess({
        completion: processCompletion.promise,
        terminate: async () => {
          processCompletion.resolve({ mode: 'local', code: null, signal: 'SIGTERM' });
        },
      }),
      timeoutMs: 50,
      cleanupPartialClone,
      onExit,
      onTimeout,
    });

    await expect(supervisor.cancel()).resolves.toBe(true);
    await expect(supervisor.completion).resolves.toBe('cancelled');
    expect(cleanupPartialClone).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('skips unsafe cleanup and reports when process-tree termination cannot be confirmed', async () => {
    const cleanupPartialClone = vi.fn(async () => undefined);
    const onTimeout = vi.fn(async (_context: RepoCloneTimeoutContext) => undefined);
    const supervisor = superviseRepoClone({
      process: fakeProcess({
        completion: new Promise<ExecutorExitResult>(() => undefined),
        terminate: async () => {
          throw new Error('process group still alive');
        },
      }),
      timeoutMs: 5,
      cleanupPartialClone,
      onExit: vi.fn(async () => undefined),
      onTimeout,
    });

    await expect(supervisor.completion).rejects.toThrow(/failed to confirm termination/i);
    expect(cleanupPartialClone).not.toHaveBeenCalled();
    expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({
      terminationError: 'process group still alive',
      error: {
        category: 'timeout',
        message: expect.stringMatching(/failed to confirm termination.*cleanup was skipped/i),
      },
    });
  });
});

describe('buildRepoCloneTimeoutError', () => {
  it('uses a timeout-specific category and conventional timeout exit code', () => {
    expect(buildRepoCloneTimeoutError(30 * 60_000)).toEqual({
      exit_code: 124,
      category: 'timeout',
      message:
        'Clone timed out after 30 minutes. The clone process tree was terminated and the partial checkout was removed.',
    });
  });
});
