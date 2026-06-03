import type { Session, Task } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  chooseBranchPromptTargetSession,
  chooseLatestBranchTask,
  chooseLatestSessionTask,
} from './latestBranchTask';

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

function session(overrides: Partial<Session> & Pick<Session, 'session_id'>): Session {
  return {
    agentic_tool: 'codex',
    status: 'idle',
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    created_by: 'user-1',
    unix_username: null,
    branch_id: 'branch-1',
    url: null,
    git_state: {
      ref: 'main',
      base_sha: 'abc',
      current_sha: 'abc',
    },
    contextFiles: [],
    genealogy: { children: [] },
    tasks: [],
    scheduled_from_branch: false,
    ready_for_prompt: false,
    archived: false,
    ...overrides,
  } as Session;
}

describe('chooseLatestBranchTask', () => {
  it('prefers an active task over a newer completed task', () => {
    const sessionA = session({ session_id: 'session-a' });
    const sessionB = session({ session_id: 'session-b' });
    const running = task({
      task_id: 'task-running',
      session_id: sessionA.session_id,
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const completed = task({
      task_id: 'task-completed',
      session_id: sessionB.session_id,
      status: 'completed',
      completed_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const result = chooseLatestBranchTask(
      new Map([
        [sessionA.session_id, [running]],
        [sessionB.session_id, [completed]],
      ]),
      new Map([
        [sessionA.session_id, sessionA],
        [sessionB.session_id, sessionB],
      ])
    );

    expect(result.task?.task_id).toBe(running.task_id);
    expect(result.session?.session_id).toBe(sessionA.session_id);
  });

  it('prefers a non-queued task over a newer queued task', () => {
    const targetSession = session({ session_id: 'session-a' });
    const completed = task({
      task_id: 'task-completed',
      session_id: targetSession.session_id,
      status: 'completed',
      completed_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const queued = task({
      task_id: 'task-queued',
      session_id: targetSession.session_id,
      status: 'queued',
      created_at: '2026-01-03T00:00:00.000Z',
    });

    const result = chooseLatestBranchTask(
      new Map([[targetSession.session_id, [completed, queued]]]),
      new Map([[targetSession.session_id, targetSession]])
    );

    expect(result.task?.task_id).toBe(completed.task_id);
  });
});

describe('chooseLatestSessionTask', () => {
  it('uses latest-task ranking within one session', () => {
    const targetSessionId = 'session-a';
    const running = task({
      task_id: 'task-running',
      session_id: targetSessionId,
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const completed = task({
      task_id: 'task-completed',
      session_id: targetSessionId,
      status: 'completed',
      completed_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    expect(chooseLatestSessionTask([completed, running])?.task_id).toBe(running.task_id);
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
});

describe('chooseBranchPromptTargetSession', () => {
  it('uses the selected session before the latest-task session', () => {
    const latestTaskSession = session({ session_id: 'latest-session' });
    const selectedSession = session({ session_id: 'selected-session' });

    const result = chooseBranchPromptTargetSession({
      sessions: [latestTaskSession, selectedSession],
      latestTaskSession,
      selectedSessionId: selectedSession.session_id,
    });

    expect(result?.session_id).toBe(selectedSession.session_id);
  });

  it('falls back to the most recently updated manual session when no latest task exists', () => {
    const older = session({
      session_id: 'older-session',
      last_updated: '2026-01-01T00:00:00.000Z',
    });
    const newer = session({
      session_id: 'newer-session',
      last_updated: '2026-01-02T00:00:00.000Z',
    });
    const scheduled = session({
      session_id: 'scheduled-session',
      scheduled_from_branch: true,
      last_updated: '2026-01-03T00:00:00.000Z',
    });

    const result = chooseBranchPromptTargetSession({
      sessions: [older, newer, scheduled],
      latestTaskSession: null,
    });

    expect(result?.session_id).toBe(newer.session_id);
  });

  it('ignores archived sessions as prompt targets', () => {
    const archived = session({
      session_id: 'archived-session',
      archived: true,
      last_updated: '2026-01-03T00:00:00.000Z',
    });
    const active = session({
      session_id: 'active-session',
      last_updated: '2026-01-01T00:00:00.000Z',
    });

    const result = chooseBranchPromptTargetSession({
      sessions: [archived, active],
      latestTaskSession: null,
    });

    expect(result?.session_id).toBe(active.session_id);
  });
});
