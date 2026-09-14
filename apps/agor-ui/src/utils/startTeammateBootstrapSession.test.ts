import type { AgorClient, UserID } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import {
  resumeTeammateBootstrapSession,
  startTeammateBootstrapSession,
} from './startTeammateBootstrapSession';

vi.mock('./waitForBranchFilesystemReady', () => ({
  waitForBranchFilesystemReady: vi.fn(async () => undefined),
}));

describe('teammate bootstrap completion', () => {
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
    const initialize = vi.fn(async () => ({ sessionId: 'session', task: { status: 'running' } }));
    const prompt = vi.fn(async () => ({ status: 'running' }));
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
    prompt.mockResolvedValue({ status: 'failed' });
    await expect(
      resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true)
    ).rejects.toThrow('recovery is pending or failed');
  });
  it('does not mistake a failed task returned by initialization for successful admission', async () => {
    const { client, initialize, options } = setup();
    initialize.mockResolvedValue({ sessionId: 'session', task: { status: 'failed' } });
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
