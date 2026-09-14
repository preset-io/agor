import { type Task, TaskStatus } from '@agor/core/types';
import type { AgorClient, SessionID, UserID } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  resumeTeammateBootstrapSession,
  startTeammateBootstrapSession,
} from './startTeammateBootstrapSession';

vi.mock('./waitForBranchFilesystemReady', () => ({
  waitForBranchFilesystemReady: vi.fn(async () => undefined),
}));

function task(status: TaskStatus): Task {
  return { task_id: 'task-1', session_id: 'session', status, full_prompt: 'Start here' } as Task;
}

describe('teammate bootstrap completion', () => {
  it.each(Object.values(TaskStatus))(
    'validates initial %s before completing setup',
    async (status) => {
      const initialization = { sessionId: 'session' as SessionID, task: task(status) };
      const onSessionCreated = vi.fn(async () => undefined);
      const result = { sessionId: 'session', initialization };
      const start = startTeammateBootstrapSession({
        client: null,
        branchId: 'branch',
        boardId: 'board',
        sessionConfig: {},
        onCreateSession: async () => result,
        onSessionCreated,
      });
      if (['running', 'completed', 'awaiting_input', 'awaiting_permission'].includes(status)) {
        await expect(start).resolves.toBe(result);
        expect(result.initialization.task.task_id).toBe('task-1');
      } else {
        await expect(start).rejects.toThrow('initialization is pending or failed');
      }
      expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith('session');
    }
  );

  it.each([
    undefined,
    { sessionId: 'session' as SessionID },
    { sessionId: 'foreign-session' as SessionID, task: task(TaskStatus.RUNNING) },
    {
      sessionId: 'session' as SessionID,
      task: { ...task(TaskStatus.RUNNING), session_id: 'foreign-session' as SessionID },
    },
  ])('fails closed on missing or mismatched initial task data', async (initialization) => {
    await expect(
      startTeammateBootstrapSession({
        client: null,
        branchId: 'branch',
        boardId: 'board',
        sessionConfig: {},
        onCreateSession: async () => ({ sessionId: 'session', initialization }),
      })
    ).rejects.toThrow('initialization is pending or failed');
  });

  it('retains the session before rejecting failed prompt initialization', async () => {
    const onSessionCreated = vi.fn(async () => undefined);
    await expect(
      startTeammateBootstrapSession({
        client: null,
        branchId: 'branch',
        boardId: 'board',
        sessionConfig: {},
        onCreateSession: async () => ({
          sessionId: 'session',
          initializationFailed: true as const,
        }),
        onSessionCreated,
      })
    ).rejects.toThrow('could not start');
    expect(onSessionCreated).toHaveBeenCalledWith('session');
  });

  function setup(tasks: unknown[] = []) {
    const initialize = vi.fn<AgorClient['sessions']['initialize']>(async () => ({
      sessionId: 'session' as SessionID,
      task: task(TaskStatus.RUNNING),
    }));
    const prompt = vi.fn<AgorClient['sessions']['prompt']>(async () => task(TaskStatus.RUNNING));
    const find = vi.fn(async () => ({ data: tasks }));
    const get = vi.fn(async () => ({
      session_id: 'session',
      branch_id: 'branch',
      created_by: 'caller',
    }));
    const client = {
      service: (name: string) => (name === 'sessions' ? { get } : { find }),
      sessions: { initialize, prompt },
    } as unknown as AgorClient;
    const options = { expectedUserId: 'caller' as UserID, prompt: 'Start here' };
    return { client, prompt, initialize, find, get, options };
  }

  it.each([TaskStatus.CREATED, TaskStatus.QUEUED, TaskStatus.DISPATCHING])(
    'resumes the exact initial %s task once launched, without any prompt replay',
    async (status) => {
      const initialTask = task(status);
      const { client, initialize, prompt, options } = setup([initialTask]);
      const onCreateSession = vi.fn(async () => ({
        sessionId: 'session',
        initialization: { sessionId: 'session' as SessionID, task: initialTask },
      }));
      await expect(
        startTeammateBootstrapSession({
          client,
          branchId: 'branch',
          boardId: 'board',
          sessionConfig: {},
          onCreateSession,
        })
      ).rejects.toThrow('initialization is pending or failed');
      await expect(
        resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
      ).rejects.toThrow('pending or stopping');
      initialTask.status = TaskStatus.RUNNING;
      await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
      expect(initialTask.task_id).toBe('task-1');
      expect(onCreateSession).toHaveBeenCalledTimes(1);
      expect(initialize).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    }
  );

  it('retries initialization on the exact saved session without creating another', async () => {
    const { client, initialize, options } = setup();
    await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
    expect(initialize).toHaveBeenCalledWith('session', options);
  });

  it('does not resend a prompt whose admission response was lost', async () => {
    const { client, initialize, options } = setup([{ session_id: 'session', status: 'running' }]);
    await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each(['created', 'queued', 'dispatching', 'stopping'])(
    'does not complete setup or duplicate %s work',
    async (status) => {
      const { client, initialize, prompt, options } = setup([{ session_id: 'session', status }]);
      await expect(
        resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
      ).rejects.toThrow('pending or stopping');
      expect(initialize).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    }
  );
  it.each(['failed', 'stopped', 'timed_out'])(
    'actually recovers %s bootstrap through normal prompting',
    async (status) => {
      const { client, prompt, initialize, options } = setup([{ session_id: 'session', status }]);
      await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
      expect(prompt).toHaveBeenCalledWith('session', 'Start here', { permissionMode: undefined });
      expect(initialize).not.toHaveBeenCalled();
    }
  );
  it('does not complete setup if recovery itself fails', async () => {
    const { client, prompt, options } = setup([{ session_id: 'session', status: 'failed' }]);
    prompt.mockResolvedValue(task(TaskStatus.FAILED));
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
    ).rejects.toThrow('recovery is pending or failed');
  });
  it('does not mistake a failed task returned by initialization for successful admission', async () => {
    const { client, initialize, options } = setup();
    initialize.mockResolvedValue({
      sessionId: 'session' as SessionID,
      task: task(TaskStatus.FAILED),
    });
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
    ).rejects.toThrow('initialization is pending or failed');
  });
  it('does not reuse another caller’s bootstrap, even if that session is readable', async () => {
    const { client, find, options } = setup([{ session_id: 'session', status: 'running' }]);
    await expect(
      resumeTeammateBootstrapSession(
        client,
        'session',
        'branch',
        { ...options, expectedUserId: 'foreign-caller' as UserID },
        () => true
      )
    ).rejects.toThrow('another caller');
    expect(find).not.toHaveBeenCalled();
  });
  it('does not treat failed task discovery as permission to retry a prompt', async () => {
    const { client, initialize, options, find } = setup();
    find.mockRejectedValue(new Error('Forbidden'));
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
    ).rejects.toThrow('Forbidden');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('rejects a different branch and stops after caller replacement', async () => {
    const { client, initialize, options, find } = setup();
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'other-branch', options, () => true)
    ).rejects.toThrow('does not belong');
    expect(find).not.toHaveBeenCalled();
    let current = true;
    find.mockImplementation(async () => {
      current = false;
      return { data: [] };
    });
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => current)
    ).rejects.toThrow('cancelled');
    expect(initialize).not.toHaveBeenCalled();
  });
});
