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
    const initialize = vi.fn(async () => ({}));
    const find = vi.fn(async () => ({ data: tasks }));
    const get = vi.fn(async () => ({ session_id: 'session', branch_id: 'branch' }));
    const client = {
      service: (name: string) => (name === 'sessions' ? { get } : { find }),
      sessions: { initialize },
    } as unknown as AgorClient;
    const options = { expectedUserId: 'caller' as UserID, prompt: 'Start here' };
    return { client, initialize, find, get, options };
  }

  it('retries initialization on the exact saved session without creating another', async () => {
    const { client, initialize, options } = setup();
    await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
    expect(initialize).toHaveBeenCalledWith('session', options);
  });

  it('does not resend a prompt whose admission response was lost', async () => {
    const { client, initialize, options } = setup([{ session_id: 'session' }]);
    await resumeTeammateBootstrapSession(client, 'session', 'branch', options, () => true);
    expect(initialize).not.toHaveBeenCalled();
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
