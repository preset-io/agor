import type { QueuedSessionCursor, QueuedSessionRef } from '@agor/core/db';
import type { SessionID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionQueueWorker } from './session-queue-worker.js';

const ref = (tenant: string, session: string): QueuedSessionRef => ({
  tenant_id: tenant,
  session_id: session as SessionID,
  first_queued_at: 1,
});

describe('SessionQueueWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries each discovered tenant into deferred queue processing', async () => {
    const processSession = vi.fn(async () => undefined);
    const worker = new SessionQueueWorker({} as never, {
      workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      discover: async () => [ref('tenant-a', 'session-a'), ref('tenant-b', 'session-b')],
      processSession,
    });

    await expect(worker.checkOnce()).resolves.toBe(2);
    expect(processSession).toHaveBeenNthCalledWith(
      1,
      'session-a',
      expect.objectContaining({ tenant: expect.objectContaining({ tenant_id: 'tenant-a' }) })
    );
    expect(processSession).toHaveBeenNthCalledWith(
      2,
      'session-b',
      expect.objectContaining({ tenant: expect.objectContaining({ tenant_id: 'tenant-b' }) })
    );
  });

  it('advances a fairness cursor and wraps only after an empty page', async () => {
    const cursors: Array<QueuedSessionCursor | undefined> = [];
    const pages = [[ref('tenant-a', 'session-a')], []] as QueuedSessionRef[][];
    const worker = new SessionQueueWorker({} as never, {
      workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      scanBatchSize: 1,
      discover: async (cursor) => {
        cursors.push(cursor);
        return pages.shift() ?? [];
      },
      processSession: async () => undefined,
    });

    await worker.checkOnce();
    await worker.checkOnce();
    await worker.checkOnce();
    expect(cursors).toEqual([
      undefined,
      { tenant_id: 'tenant-a', session_id: 'session-a' },
      undefined,
    ]);
  });

  it('waits for the recovery cadence after a short page instead of hot-polling a blocker', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const discover = vi.fn(async () => [ref('tenant-a', 'session-a')]);
    const processSession = vi.fn(async () => undefined);
    const worker = new SessionQueueWorker({} as never, {
      workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      discover,
      processSession,
      recoveryIntervalMs: 60_000,
      random: () => 0.5,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(processSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(processSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processSession).toHaveBeenCalledTimes(2);
    expect(info.mock.calls.flat().join('\n')).not.toContain('recovery_sweep_found_work');
    worker.stop();
  });

  it('bounds saturated recovery work and resumes from its fairness cursor', async () => {
    vi.useFakeTimers();
    const pages = [[ref('tenant-a', 'session-a')], [ref('tenant-a', 'session-b')], []];
    const discover = vi.fn(async () => pages.shift() ?? []);
    const processSession = vi.fn(async () => undefined);
    const worker = new SessionQueueWorker({} as never, {
      workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      scanBatchSize: 1,
      maxPagesPerSweep: 2,
      discover,
      processSession,
      recoveryIntervalMs: 60_000,
      random: () => 0.5,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(15_300);
    expect(processSession).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_849);
    expect(discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(discover).toHaveBeenLastCalledWith({
      tenant_id: 'tenant-a',
      session_id: 'session-b',
    });
    worker.stop();
  });
});
