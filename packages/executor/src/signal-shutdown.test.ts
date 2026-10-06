import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorSignalShutdown, EXECUTOR_SIGNAL_GRACE_MS } from './signal-shutdown.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded executor signal shutdown', () => {
  it('deduplicates TERM/INT and does not exit before cleanup/reporting completes', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const exit = vi.fn();
    const shutdown = createExecutorSignalShutdown({ shutdown: work, exit, warn: vi.fn() });
    const first = shutdown('SIGTERM');
    expect(shutdown('SIGINT')).toBe(first);
    expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await first;
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    await vi.advanceTimersByTimeAsync(EXECUTOR_SIGNAL_GRACE_MS);
    expect(exit).toHaveBeenCalledOnce();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'bounds hanging cleanup/transport after %s',
    async (signal) => {
      vi.useFakeTimers();
      let finish!: () => void;
      let deadline!: AbortSignal;
      const exit = vi.fn();
      const warn = vi.fn();
      const shutdown = createExecutorSignalShutdown({
        shutdown: (_signal, aborted) => {
          deadline = aborted;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        exit,
        warn,
      });
      const done = shutdown(signal);
      await vi.advanceTimersByTimeAsync(EXECUTOR_SIGNAL_GRACE_MS);
      await done;
      expect(deadline.aborted).toBe(true);
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('deadline_exceeded'));
      expect(exit).toHaveBeenCalledExactlyOnceWith(signal === 'SIGTERM' ? 143 : 130);
      finish();
      await Promise.resolve();
      expect(exit).toHaveBeenCalledOnce();
    }
  );

  it('sanitizes reporting errors and exits nonzero once', async () => {
    const exit = vi.fn();
    const warn = vi.fn();
    const shutdown = createExecutorSignalShutdown({
      shutdown: async () => {
        throw new Error('secret transport detail');
      },
      exit,
      warn,
    });
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[executor.signal] event=report_failed containment=unverified'
    );
  });
});

// These are disposable children only. No host OOM, production PID, shared
// process group, or ambient executable discovery is involved.
describe.skipIf(process.platform === 'win32')('real signal delivery', () => {
  it.each(['SIGTERM', 'SIGKILL'] as const)(
    '%s permits cleanup only when catchable',
    async (signal) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../test/fixtures/signal-child.ts', import.meta.url)),
          ...(signal === 'SIGTERM' ? ['descendant'] : []),
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
      );
      let output = '';
      child.stdout!.on('data', (chunk) => {
        output += String(chunk);
      });
      const exited = once(child, 'close');
      try {
        await once(child, 'message', { signal: AbortSignal.timeout(3_000) });
        child.kill(signal);
        const [code, exitSignal] = await exited;
        if (signal === 'SIGTERM') {
          expect(code).toBe(143);
          expect(exitSignal).toBeNull();
          expect(output).toContain('cleanup-complete');
          expect(output).toContain('descendant-exited');
          expect(output).toContain('report-complete');
        } else {
          expect(code).toBeNull();
          expect(exitSignal).toBe('SIGKILL');
          expect(output).not.toContain('report-complete');
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
  );
});
