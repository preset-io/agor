import type { AgorClient, Task } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { reconcileStopTransportFailure } from './stopReconciliation';

const sessionId = '018f0000-0000-7000-8000-000000000001' as never;
const taskId = '018f0000-0000-7000-8000-000000000002' as never;

function clientWithTask(task: Task, connected = true) {
  const get = vi.fn().mockResolvedValue(task);
  const client = {
    io: { connected },
    service: () => ({ get }),
  } as unknown as AgorClient;
  return { client, get };
}

describe('reconcileStopTransportFailure', () => {
  it('recognizes a durably accepted Stop after its Socket.IO acknowledgement is lost', async () => {
    const { client, get } = clientWithTask({
      task_id: taskId,
      session_id: sessionId,
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-08-29T00:00:00.000Z',
      },
    } as Task);

    await expect(
      reconcileStopTransportFailure(() => client, sessionId, taskId, 50)
    ).resolves.toEqual({
      outcome: 'accepted',
      reason: 'Stop was accepted; waiting for executor termination.',
    });
    expect(get).toHaveBeenCalledWith(taskId);
  });

  it('reconciles through the replacement client after a token reconnect', async () => {
    let current = {
      io: { connected: false },
      service: vi.fn(),
    } as unknown as AgorClient;
    const replacement = clientWithTask({
      task_id: taskId,
      session_id: sessionId,
      status: 'stopped',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-08-29T00:00:00.000Z',
      },
    } as Task);
    setTimeout(() => {
      current = replacement.client;
    }, 10);

    await expect(
      reconcileStopTransportFailure(() => current, sessionId, taskId, 200)
    ).resolves.toEqual({ outcome: 'accepted', reason: 'Stop completed.' });
    expect(replacement.get).toHaveBeenCalledOnce();
  });

  it('does not treat another session task as proof that Stop committed', async () => {
    const { client } = clientWithTask({
      task_id: taskId,
      session_id: 'another-session',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-08-29T00:00:00.000Z',
      },
    } as Task);

    await expect(
      reconcileStopTransportFailure(() => client, sessionId, taskId, 50)
    ).resolves.toEqual({ outcome: 'unresolved' });
  });
});
