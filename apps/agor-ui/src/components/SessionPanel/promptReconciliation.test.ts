import type { AgorClient, Task } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_DISCONNECTED_ERROR } from '../../utils/connectionErrors';
import {
  PROMPT_NOT_SENT_MESSAGE,
  PROMPT_OUTCOME_UNKNOWN_MESSAGE,
  reconcilePromptTransportFailure,
  sendPromptWithReconciliation,
} from './promptReconciliation';

const attempt = { sessionId: 'session-1', userId: 'user-a', prompt: 'Ship it' };
const NOT_SENT = `${PROMPT_NOT_SENT_MESSAGE} (socket has been disconnected)`;
const UNKNOWN = `${PROMPT_OUTCOME_UNKNOWN_MESSAGE} (socket has been disconnected)`;

/** UUIDv7-shaped ids that sort in creation order. */
function taskId(n: number): string {
  return `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function task(n: number, overrides: Partial<Task> = {}): Task {
  return {
    task_id: taskId(n),
    session_id: attempt.sessionId,
    created_by: attempt.userId,
    full_prompt: attempt.prompt,
    status: 'queued',
    created_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/** The pre-send baseline asks for one task id; the post-loss check asks for the recent page. */
function mockClient({
  before = [],
  after = [],
  connected = true,
}: {
  before?: Task[] | Error;
  after?: Task[] | Error;
  connected?: boolean;
}) {
  const find = vi.fn(async ({ query }: { query: { $limit: number } }) => {
    const result = query.$limit === 1 ? before : after;
    if (result instanceof Error) throw result;
    return { data: result };
  });
  const client = { io: { connected }, service: () => ({ find }) } as unknown as AgorClient;
  return { client, find };
}

function sendLosingConnection(client: AgorClient | null) {
  const showError = vi.fn();
  const send = vi.fn(() => Promise.reject(new Error(SOCKET_DISCONNECTED_ERROR)));
  const result = sendPromptWithReconciliation({
    send,
    getClient: () => client,
    attempt,
    showError,
    reconnectTimeoutMs: 50,
  });
  return { result, showError, send };
}

describe('sendPromptWithReconciliation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('treats a new matching task as sent, without a toast', async () => {
    const { client, find } = mockClient({ before: [task(1)], after: [task(2), task(1)] });
    const { result, showError } = sendLosingConnection(client);
    await expect(result).resolves.toBe(true);
    expect(showError).not.toHaveBeenCalled();
    expect(find).toHaveBeenNthCalledWith(1, {
      query: {
        session_id: 'session-1',
        created_by: 'user-a',
        $sort: { task_id: -1 },
        $limit: 1,
        $select: ['task_id'],
      },
    });
    expect(find).toHaveBeenNthCalledWith(2, {
      query: {
        session_id: 'session-1',
        created_by: 'user-a',
        $sort: { task_id: -1 },
        $limit: 20,
        $select: ['task_id', 'session_id', 'created_by', 'full_prompt'],
      },
    });
  });

  it('treats the first prompt in a session as sent when it shows up', async () => {
    const { client } = mockClient({ before: [], after: [task(1)] });
    await expect(sendLosingConnection(client).result).resolves.toBe(true);
  });

  it('does not mistake an identical earlier prompt for this one', async () => {
    const { client } = mockClient({ before: [task(1)], after: [task(1)] });
    const { result, showError } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(showError).toHaveBeenCalledExactlyOnceWith(UNKNOWN);
  });

  it('ignores clock skew between browser and daemon', async () => {
    const skewed = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { client } = mockClient({
      before: [task(1)],
      after: [task(2, { created_at: skewed }), task(1)],
    });
    await expect(sendLosingConnection(client).result).resolves.toBe(true);
  });

  it('never claims "not sent" when no new matching task is found yet', async () => {
    const { client } = mockClient({
      before: [task(1)],
      after: [
        task(3, { full_prompt: 'Something else' }),
        task(2, { created_by: 'user-b' }),
        task(1),
      ],
    });
    const { result, showError } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(showError).toHaveBeenCalledExactlyOnceWith(UNKNOWN);
  });

  it('asks the user to check the conversation while still offline', async () => {
    const { client, find } = mockClient({ connected: false });
    const { result, showError } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(find).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledExactlyOnceWith(UNKNOWN);
  });

  it('asks the user to check the conversation when the check fails', async () => {
    const { client } = mockClient({ after: new Error('Forbidden') });
    const { result, showError } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(showError).toHaveBeenCalledExactlyOnceWith(UNKNOWN);
  });

  it('does not send when the connection drops before the prompt goes out', async () => {
    const { client } = mockClient({ before: new Error(SOCKET_DISCONNECTED_ERROR) });
    const { result, showError, send } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledExactlyOnceWith(NOT_SENT);
  });

  it('still sends without a baseline, but cannot then confirm a landing', async () => {
    const { client, find } = mockClient({ before: new Error('Forbidden'), after: [task(2)] });
    const { result, showError, send } = sendLosingConnection(client);
    await expect(result).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledExactlyOnceWith(UNKNOWN);
  });

  it('keeps the existing toast for other errors without reconciling', async () => {
    const { client, find } = mockClient({});
    const showError = vi.fn();
    await expect(
      sendPromptWithReconciliation({
        send: () => Promise.reject(new Error('Session is archived')),
        getClient: () => client,
        attempt,
        showError,
      })
    ).resolves.toBe(false);
    expect(find).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith("Couldn't send your message. (Session is archived)");
  });

  it('stays silent when the caller is no longer current', async () => {
    const { client } = mockClient({});
    const showError = vi.fn();
    await expect(
      sendPromptWithReconciliation({
        send: () => Promise.reject(new Error(SOCKET_DISCONNECTED_ERROR)),
        getClient: () => client,
        attempt,
        showError,
        isCurrent: () => false,
      })
    ).resolves.toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('reconcilePromptTransportFailure', () => {
  it('waits for the replacement client after a reconnect', async () => {
    let current: AgorClient | null = null;
    const { client } = mockClient({ after: [task(2)] });
    setTimeout(() => {
      current = client;
    }, 10);
    await expect(
      reconcilePromptTransportFailure(() => current, { ...attempt, baselineTaskId: taskId(1) }, 500)
    ).resolves.toBe('landed');
  });
});
