import type { Task } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { chooseLatestSessionTask } from './latestSessionTask';

function task(overrides: Partial<Task> & Pick<Task, 'task_id' | 'session_id' | 'status'>): Task {
  const createdAt = overrides.created_at ?? '2026-01-01T00:00:00.000Z';
  return {
    created_by: 'user-1',
    full_prompt: 'prompt',
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: createdAt,
    },
    tool_use_count: 0,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc',
    },
    created_at: createdAt,
    ...overrides,
  } as Task;
}

describe('chooseLatestSessionTask', () => {
  it('prefers an active task over a newer completed task', () => {
    const running = task({
      task_id: 'task-running',
      session_id: 'session-a',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const completed = task({
      task_id: 'task-completed',
      session_id: 'session-a',
      status: 'completed',
      completed_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    expect(chooseLatestSessionTask([completed, running])?.task_id).toBe(running.task_id);
  });

  it('prefers a non-queued task over a newer queued task', () => {
    const completed = task({
      task_id: 'task-completed',
      session_id: 'session-a',
      status: 'completed',
      completed_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const queued = task({
      task_id: 'task-queued',
      session_id: 'session-a',
      status: 'queued',
      created_at: '2026-01-03T00:00:00.000Z',
    });

    expect(chooseLatestSessionTask([completed, queued])?.task_id).toBe(completed.task_id);
  });

  it('deduplicates queued and task-list copies by task id', () => {
    const queued = task({
      task_id: 'task-queued',
      session_id: 'session-a',
      status: 'queued',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    expect(chooseLatestSessionTask([queued, queued])?.task_id).toBe(queued.task_id);
  });

  it('prefers a task that ran over an unstarted terminal task', () => {
    const stoppedRunning = task({
      task_id: 'task-running',
      session_id: 'session-a',
      status: 'stopped',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      message_range: {
        start_index: 0,
        end_index: 1,
        start_timestamp: '2026-01-01T00:00:00.000Z',
        end_timestamp: '2026-01-01T00:00:05.000Z',
      },
    });
    const unstartedTerminal = task({
      task_id: 'task-unstarted-terminal',
      session_id: 'session-a',
      status: 'stopped',
      completed_at: '2026-01-01T00:00:05.000Z',
      created_at: '2026-01-01T00:00:01.000Z',
      message_range: {
        start_index: -1,
        end_index: -1,
        start_timestamp: '2026-01-01T00:00:01.000Z',
      },
    });

    expect(chooseLatestSessionTask([unstartedTerminal, stoppedRunning])?.task_id).toBe(
      stoppedRunning.task_id
    );
  });
});
