import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutorShutdown } from './shutdown.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExecutorShutdown', () => {
  it('aborts once and exits gracefully after finalization', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const abortController = new AbortController();
    const exit = vi.fn();
    const markStopped = vi.fn(() => stopped.promise);
    const shutdown = new ExecutorShutdown({
      abortController,
      isRunning: () => true,
      markStopped,
      exit,
    });

    const triggered = shutdown.trigger('SIGTERM');

    expect(abortController.signal.aborted).toBe(true);
    expect(markStopped).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    const finished = shutdown.finishGracefully();
    expect(markStopped).toHaveBeenCalledOnce();
    stopped.resolve();
    await triggered;
    await expect(finished).resolves.toBe(true);
    await expect(shutdown.finishGracefully()).resolves.toBe(true);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('forces exit when shutdown work does not settle', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = new ExecutorShutdown({
      abortController: new AbortController(),
      isRunning: () => true,
      markStopped: () => new Promise<void>(() => {}),
      exit,
    });

    void shutdown.trigger('SIGINT');
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reuses one shutdown for repeated signals', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const abortController = new AbortController();
    const abort = vi.fn();
    abortController.signal.addEventListener('abort', abort);
    const markStopped = vi.fn(() => stopped.promise);
    const log = vi.fn();
    const shutdown = new ExecutorShutdown({
      abortController,
      isRunning: () => true,
      markStopped,
      exit: vi.fn(),
      log,
    });

    const first = shutdown.trigger('SIGTERM');
    const second = shutdown.trigger('SIGINT');

    expect(second).toBe(first);
    expect(abort).toHaveBeenCalledOnce();
    expect(markStopped).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();

    const finished = shutdown.finishGracefully();
    expect(markStopped).toHaveBeenCalledOnce();
    stopped.resolve();
    await first;
    await finished;
  });

  it('marks an idle task stopped before exiting', async () => {
    const events: string[] = [];
    const shutdown = new ExecutorShutdown({
      abortController: new AbortController(),
      isRunning: () => false,
      markStopped: async () => {
        events.push('marked');
      },
      exit: () => {
        events.push('exited');
      },
    });

    await shutdown.trigger('SIGTERM');

    expect(events).toEqual(['marked', 'exited']);
  });

  it('exits failed on lease loss without rewriting the daemon terminal state', async () => {
    const abortController = new AbortController();
    const markStopped = vi.fn();
    const exit = vi.fn();
    const shutdown = new ExecutorShutdown({
      abortController,
      isRunning: () => true,
      markStopped,
      exit,
    });

    void shutdown.loseLease();
    await expect(shutdown.finishGracefully()).resolves.toBe(true);

    expect(abortController.signal.aborted).toBe(true);
    expect(markStopped).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
