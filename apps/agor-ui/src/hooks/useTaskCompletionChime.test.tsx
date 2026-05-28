/**
 * Regression coverage for {@link useTaskCompletionChime}.
 *
 * The chime is "play once when *my* task transitions from RUNNING to a
 * natural terminal state". The trickiest behavior is dedupe across
 * redundant terminal events for the same task_id — that is the bug this
 * hook had before the `chimed` set was added, and what most tests below
 * pin down.
 */

import type { AgorClient, AudioPreferences, Task, TaskID } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playChimeMock = vi.fn<(task: Task, prefs?: AudioPreferences) => Promise<void>>();

vi.mock('../utils/audio', () => ({
  playTaskCompletionChime: (task: Task, prefs?: AudioPreferences) => playChimeMock(task, prefs),
}));

import { MAX_CHIMED_HISTORY, useTaskCompletionChime } from './useTaskCompletionChime';

const USER_ID = 'user-123';

type TaskEvent = 'created' | 'patched' | 'updated' | 'removed';

interface MockTasksService {
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  findAll: ReturnType<typeof vi.fn>;
  emit(event: TaskEvent, task: Partial<Task>): void;
}

interface MockClient {
  service: ReturnType<typeof vi.fn>;
  __tasks: MockTasksService;
}

/**
 * Build a mock AgorClient whose tasks service stores `on`/`removeListener`
 * registrations in a Map keyed by event name, plus an `emit` helper that
 * fires every registered handler — exactly the contract the hook depends on.
 *
 * `findAll` returns an empty array by default (no tasks currently RUNNING),
 * but tests can override before render via `client.__tasks.findAll.mockResolvedValueOnce`.
 */
function makeMockClient(): MockClient {
  const listeners = new Map<TaskEvent, Array<(task: Partial<Task>) => void>>();
  const tasksService: MockTasksService = {
    on: vi.fn((event: TaskEvent, fn: (task: Partial<Task>) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
    }),
    removeListener: vi.fn((event: TaskEvent, fn: (task: Partial<Task>) => void) => {
      const arr = listeners.get(event) ?? [];
      listeners.set(
        event,
        arr.filter((f) => f !== fn)
      );
    }),
    findAll: vi.fn().mockResolvedValue([]),
    emit: (event, task) => {
      // Snapshot the listener array — mirrors EventEmitter semantics so a
      // handler that mutates registrations mid-emit doesn't break iteration.
      for (const fn of [...(listeners.get(event) ?? [])]) fn(task);
    },
  };

  return {
    service: vi.fn(() => tasksService),
    __tasks: tasksService,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'task_id' | 'status'>): Partial<Task> {
  return {
    session_id: 'sess-1' as Task['session_id'],
    created_by: USER_ID,
    full_prompt: 'do the thing',
    tool_use_count: 0,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
    message_range: { start_index: 0, end_index: 0, start_timestamp: '0' },
    created_at: '0',
    ...overrides,
  };
}

const audioPrefs: AudioPreferences = {
  enabled: true,
  chime: 'gentle-chime',
  volume: 0.5,
  minDurationSeconds: 0,
};

function render(client: MockClient | null) {
  return renderHook(
    ({ c }: { c: MockClient | null }) =>
      useTaskCompletionChime((c as unknown as AgorClient) ?? null, USER_ID, audioPrefs),
    { initialProps: { c: client } }
  );
}

describe('useTaskCompletionChime', () => {
  beforeEach(() => {
    playChimeMock.mockReset();
    playChimeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('plays exactly one chime on RUNNING → COMPLETED', () => {
    const client = makeMockClient();
    render(client);

    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
    );
    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
    );

    expect(playChimeMock).toHaveBeenCalledTimes(1);
  });

  it('plays one chime on RUNNING → FAILED', () => {
    const client = makeMockClient();
    render(client);

    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
    );
    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.FAILED })
    );

    expect(playChimeMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT chime on STOPPED — user-initiated stop is not a natural completion', () => {
    const client = makeMockClient();
    render(client);

    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
    );
    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.STOPPED })
    );

    expect(playChimeMock).not.toHaveBeenCalled();
  });

  it('does NOT chime on TIMED_OUT', () => {
    const client = makeMockClient();
    render(client);

    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
    );
    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.TIMED_OUT })
    );

    expect(playChimeMock).not.toHaveBeenCalled();
  });

  it('does NOT chime for tasks owned by a different user (multiplayer scoping)', () => {
    const client = makeMockClient();
    render(client);

    const otherUserTask = makeTask({
      task_id: 't1' as TaskID,
      status: TaskStatus.RUNNING,
      created_by: 'other-user',
    });
    client.__tasks.emit('patched', otherUserTask);
    client.__tasks.emit(
      'patched',
      makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED, created_by: 'other-user' })
    );

    expect(playChimeMock).not.toHaveBeenCalled();
  });

  describe('duplicate completion events', () => {
    // Each scenario below is a real-world way the daemon can produce two
    // terminal events for the *same* task_id. The fix guarantees one chime.

    it('dedupes a second identical patched event for the same task', () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      // Replay (socket reconnect, daemon-side double-emit, etc.) — must NOT
      // re-chime.
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it("dedupes daemon-side `'updated' + 'patched'` paired emit (DrizzleService.update)", () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      // DrizzleService.update() fires both events synchronously for a single
      // operation. UI listens to both — should still chime once.
      client.__tasks.emit(
        'updated',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it('dedupes a post-completion `session_md5` patch (stateless_fs_mode)', () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      // Daemon writes session_md5 after the executor exits — the resulting
      // `'patched'` broadcast still carries status=COMPLETED.
      client.__tasks.emit(
        'patched',
        makeTask({
          task_id: 't1' as TaskID,
          status: TaskStatus.COMPLETED,
          session_md5: 'abc123',
        })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it('dedupes double-FAILED patches (base-executor + index.ts double-catch)', () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      // base-executor's catch patches to FAILED then re-throws; the outer
      // catch in executor/index.ts patches to FAILED again.
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.FAILED })
      );
      client.__tasks.emit(
        'patched',
        makeTask({
          task_id: 't1' as TaskID,
          status: TaskStatus.FAILED,
          error_message: 'something else',
        })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it('survives a status flicker (RUNNING → AWAITING_PERMISSION → RUNNING → COMPLETED → COMPLETED)', () => {
      const client = makeMockClient();
      render(client);

      const t = (status: TaskStatus) => makeTask({ task_id: 't1' as TaskID, status });

      client.__tasks.emit('patched', t(TaskStatus.RUNNING));
      client.__tasks.emit('patched', t(TaskStatus.AWAITING_PERMISSION));
      client.__tasks.emit('patched', t(TaskStatus.RUNNING));
      client.__tasks.emit('patched', t(TaskStatus.COMPLETED));
      // Replay — must NOT bypass the dedupe just because the running-set
      // was rebuilt after AWAITING_PERMISSION.
      client.__tasks.emit('patched', t(TaskStatus.COMPLETED));

      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it('dedupe survives subscription teardown + remount (token rotation)', () => {
      const client1 = makeMockClient();
      const { rerender } = render(client1);

      client1.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client1.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      expect(playChimeMock).toHaveBeenCalledTimes(1);

      // Token rotation / auth flip: new client instance, hook re-subscribes.
      // The seed fetch on the new client will NOT include t1 (it's already
      // COMPLETED in DB), but a delayed replay of the COMPLETED event must
      // still not chime.
      const client2 = makeMockClient();
      // Seed the running set as if t1 were still considered running.
      // This simulates the worst case: a stale RUNNING row arrives via the
      // seed fetch, then a delayed COMPLETED replay lands on the new sub.
      client2.__tasks.findAll.mockResolvedValueOnce([
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING }),
      ]);
      rerender({ c: client2 });

      // Let the seed fetch resolve before firing the replay.
      return waitFor(() => {
        expect(client2.__tasks.findAll).toHaveBeenCalled();
      }).then(() => {
        client2.__tasks.emit(
          'patched',
          makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
        );
        expect(playChimeMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('legitimate separate completions', () => {
    it('chimes once per distinct task — different task_ids must each fire', () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't2' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't2' as TaskID, status: TaskStatus.COMPLETED })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(2);
    });

    it('callback chain — child completion + parent completion both chime', () => {
      // child task finishes → daemon queues a callback prompt as a NEW task
      // on the parent → parent task runs and completes. The user should
      // hear BOTH chimes (they're separate, legitimate completions).
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 'child' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 'child' as TaskID, status: TaskStatus.COMPLETED })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 'parent-cb' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 'parent-cb' as TaskID, status: TaskStatus.COMPLETED })
      );

      expect(playChimeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('LRU bounds', () => {
    it('caps the chimed-history set at MAX_CHIMED_HISTORY entries', () => {
      const client = makeMockClient();
      render(client);

      // Fire MAX_CHIMED_HISTORY + 1 unique completions. The very first
      // task_id gets evicted from the chimed-set as the cap rolls over.
      for (let i = 0; i < MAX_CHIMED_HISTORY + 1; i++) {
        client.__tasks.emit(
          'patched',
          makeTask({ task_id: `t${i}` as TaskID, status: TaskStatus.RUNNING })
        );
        client.__tasks.emit(
          'patched',
          makeTask({ task_id: `t${i}` as TaskID, status: TaskStatus.COMPLETED })
        );
      }
      expect(playChimeMock).toHaveBeenCalledTimes(MAX_CHIMED_HISTORY + 1);

      playChimeMock.mockClear();

      // The OLDEST entry (t0) was evicted, so a replay for it WOULD chime
      // again if the running-set is reseeded. This is the documented
      // trade-off — keeping the cap simple and the hook's working memory
      // bounded.
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't0' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't0' as TaskID, status: TaskStatus.COMPLETED })
      );
      expect(playChimeMock).toHaveBeenCalledTimes(1);

      // A task we know is still in the chimed window (e.g. the LAST one
      // we fired above) does NOT re-chime on replay.
      const lastIdx = MAX_CHIMED_HISTORY; // we ran i = 0..MAX, last id = `t${MAX}`
      playChimeMock.mockClear();
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: `t${lastIdx}` as TaskID, status: TaskStatus.COMPLETED })
      );
      expect(playChimeMock).not.toHaveBeenCalled();
    });
  });

  describe('subscription lifecycle', () => {
    it('unsubscribes on unmount', () => {
      const client = makeMockClient();
      const { unmount } = render(client);

      expect(client.__tasks.on).toHaveBeenCalledWith('created', expect.any(Function));
      expect(client.__tasks.on).toHaveBeenCalledWith('patched', expect.any(Function));
      expect(client.__tasks.on).toHaveBeenCalledWith('updated', expect.any(Function));
      expect(client.__tasks.on).toHaveBeenCalledWith('removed', expect.any(Function));

      unmount();

      expect(client.__tasks.removeListener).toHaveBeenCalledWith('created', expect.any(Function));
      expect(client.__tasks.removeListener).toHaveBeenCalledWith('patched', expect.any(Function));
      expect(client.__tasks.removeListener).toHaveBeenCalledWith('updated', expect.any(Function));
      expect(client.__tasks.removeListener).toHaveBeenCalledWith('removed', expect.any(Function));
    });

    it('does nothing when client is null', () => {
      const { rerender: _rerender } = render(null);
      expect(playChimeMock).not.toHaveBeenCalled();
      // No way to fire events without a client — just verifying no crash.
    });

    it('chimes for a task seeded as RUNNING from findAll', async () => {
      const client = makeMockClient();
      client.__tasks.findAll.mockResolvedValueOnce([
        makeTask({ task_id: 'seed-1' as TaskID, status: TaskStatus.RUNNING }),
      ]);
      render(client);

      // Wait for the seed fetch to populate the running set.
      await waitFor(() => {
        expect(client.__tasks.findAll).toHaveBeenCalledWith({
          query: { status: TaskStatus.RUNNING, created_by: USER_ID },
        });
      });

      // Now the live COMPLETED event should find seed-1 in the running set
      // and chime — even though we never saw its RUNNING transition.
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 'seed-1' as TaskID, status: TaskStatus.COMPLETED })
      );

      await waitFor(() => {
        expect(playChimeMock).toHaveBeenCalledTimes(1);
      });
    });

    it('frees chimed-set slot when task is removed', () => {
      const client = makeMockClient();
      render(client);

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      expect(playChimeMock).toHaveBeenCalledTimes(1);

      // Task deleted (e.g. admin removed it). After this the dedupe slot
      // is freed, so an unrelated future task with the (unlikely) same
      // task_id would chime — verified by replay below.
      client.__tasks.emit(
        'removed',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      playChimeMock.mockClear();

      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.RUNNING })
      );
      client.__tasks.emit(
        'patched',
        makeTask({ task_id: 't1' as TaskID, status: TaskStatus.COMPLETED })
      );
      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });
  });
});
