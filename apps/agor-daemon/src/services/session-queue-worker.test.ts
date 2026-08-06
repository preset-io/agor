import type { QueuedSessionCursor, QueuedSessionRef } from '@agor/core/db';
import type { SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { SessionQueueWorker } from './session-queue-worker.js';

const ref = (tenant: string, session: string): QueuedSessionRef => ({
  tenant_id: tenant,
  session_id: session as SessionID,
  first_queued_at: 1,
});

describe('SessionQueueWorker', () => {
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
});
