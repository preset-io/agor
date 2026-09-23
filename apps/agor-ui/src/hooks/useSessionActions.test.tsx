import type { AgorClient, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bumpRevision } from '../store/agorHydration';
import { buildSessionMaps } from '../store/agorMaps';
import { sessionPatched } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import {
  enqueueSessionPatch,
  flushRealtimeNow,
  setRealtimeAuthorityScope,
} from '../store/realtimeBatch';
import { useSessionActions } from './useSessionActions';

describe('useSessionActions MCP selection', () => {
  it.each([[['selected-server']], [[]], [undefined]])(
    'preserves the explicit or omitted selection %j in the create request',
    async (mcpServerIds) => {
      const create = vi.fn(
        async (_input: { mcpServerIds?: string[] }) => ({ session_id: 'session-1' }) as Session
      );
      const { result } = renderHook(() => useSessionActions(makeClient({ sessions: { create } })));

      await act(async () => {
        await result.current.createSession({
          branch_id: 'branch-1',
          agent: 'claude-code',
          mcpServerIds,
        });
      });

      expect(create.mock.calls[0][0].mcpServerIds).toEqual(mcpServerIds);
    }
  );
});

function makeClient(services: Record<string, unknown>): AgorClient {
  return {
    service: vi.fn((name: string) => {
      const service = services[name];
      if (!service) throw new Error(`Unexpected service: ${name}`);
      return service;
    }),
  } as unknown as AgorClient;
}

describe('useSessionActions archive helpers', () => {
  it('archives through the cascade archive route instead of generic sessions.patch', async () => {
    const archivedSession = { session_id: 'session-1', archived: true } as Session;
    const archiveCreate = vi.fn(async () => ({ session: archivedSession }));
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/archive': { create: archiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: Awaited<ReturnType<typeof result.current.archiveSession>> = null;
    await act(async () => {
      returned = await result.current.archiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toEqual({ session: archivedSession, reconciliation: 'confirmed' });
    expect(archiveCreate).toHaveBeenCalledWith({});
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('unarchives through the cascade unarchive route instead of generic sessions.patch', async () => {
    const unarchivedSession = { session_id: 'session-1', archived: false } as Session;
    const unarchiveCreate = vi.fn(async () => ({ session: unarchivedSession }));
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/unarchive': { create: unarchiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: Session | null = null;
    await act(async () => {
      returned = await result.current.unarchiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toBe(unarchivedSession);
    expect(unarchiveCreate).toHaveBeenCalledWith({});
    expect(sessionsPatch).not.toHaveBeenCalled();
  });
});

it('preserves the session create failure for its caller', async () => {
  const failure = new Error('Select an exact provider and model');
  const client = makeClient({
    sessions: { create: vi.fn(async () => Promise.reject(failure)) },
  });
  const { result } = renderHook(() => useSessionActions(client));

  await act(async () => {
    await expect(
      result.current.createSession({ branch_id: 'branch-1', agent: 'opencode' })
    ).rejects.toBe(failure);
  });
  expect(result.current.error).toBe(failure.message);
});

describe('archive response reconciliation', () => {
  const session = (id: string, parent?: string, branch = 'branch-1'): Session => ({
    session_id: id as Session['session_id'],
    branch_id: branch as Session['branch_id'],
    agentic_tool: 'codex',
    status: 'idle',
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: '2026-09-01T00:00:00.000Z',
    created_by: 'user-a',
    unix_username: null,
    sdk_home_scope: 'branch',
    url: null,
    contextFiles: [],
    tasks: [],
    scheduled_from_branch: false,
    ready_for_prompt: true,
    archived: false,
    genealogy: { parent_session_id: parent as Session['session_id'] | undefined, children: [] },
  });
  const parent = session('parent');
  const child = session('child', 'parent');
  const grandchild = session('grandchild', 'child');
  const sibling = session('sibling', 'parent');
  const unrelated = session('unrelated');
  const orphan = session('orphan', 'unloaded-parent');
  const remote = session('remote', 'parent', 'other-branch');
  const sessions = [parent, child, grandchild, sibling, unrelated, orphan, remote];

  beforeEach(() => {
    agorStore.getState().reset();
    agorStore.getState().applyMaps((prev) => ({ ...prev, ...buildSessionMaps(sessions) }));
    setRealtimeAuthorityScope('tenant-a:user-a:1');
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
    agorStore.getState().reset();
  });

  function expectActive(expected: Session[]) {
    expect([...agorStore.getState().sessionById.keys()].sort()).toEqual(
      expected.map((s) => s.session_id).sort()
    );
    expect(
      [...agorStore.getState().sessionsByBranch.values()]
        .flat()
        .map((s) => s.session_id)
        .sort()
    ).toEqual(expected.map((s) => s.session_id).sort());
  }

  it('removes the confirmed parent, children and grandchild even when only the parent event arrived', async () => {
    const affectedSessions = [parent, child, grandchild, sibling].map((s) => ({
      ...s,
      archived: true,
      last_updated: '2026-09-01T00:00:01.000Z',
    }));
    const archiveCreate = vi.fn(async () => ({ session: affectedSessions[0], affectedSessions }));
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          'sessions/parent/archive': { create: archiveCreate },
          sessions: {
            get: async (id: string) => affectedSessions.find((s) => s.session_id === id),
          },
        })
      )
    );
    act(() => sessionPatched(affectedSessions[0]));
    await act(async () => {
      expect(await result.current.archiveSession(parent.session_id)).toEqual({
        session: affectedSessions[0],
        reconciliation: 'confirmed',
      });
    });
    expectActive([unrelated, orphan, remote]);
    // Late/duplicate realtime delivery must be idempotent.
    act(() => affectedSessions.forEach(sessionPatched));
    expectActive([unrelated, orphan, remote]);
  });

  it('archiving a child removes only that subtree, not its parent or sibling', async () => {
    const affectedSessions = [child, grandchild].map((s) => ({
      ...s,
      archived: true,
      last_updated: '2026-09-01T00:00:01.000Z',
    }));
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          sessions: {
            get: async (id: string) => affectedSessions.find((s) => s.session_id === id),
          },
          'sessions/child/archive': {
            create: async () => ({ session: affectedSessions[0], affectedSessions }),
          },
        })
      )
    );
    await act(async () => {
      await result.current.archiveSession(child.session_id);
    });
    expectActive([parent, sibling, unrelated, orphan, remote]);
  });

  it('uses only the returned root when no affected list is supplied, without guessing descendants', async () => {
    const archived = { ...parent, archived: true, last_updated: '2026-09-01T00:00:01.000Z' };
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          'sessions/parent/archive': { create: async () => ({ session: archived }) },
          sessions: { get: async () => archived },
        })
      )
    );
    await act(async () => {
      await result.current.archiveSession(parent.session_id);
    });
    expectActive(sessions.filter((s) => s !== parent));
  });

  it.each(['none', 'queued', 'applied'] as const)(
    'reconciles an unchanged archived root plus changed children, preserving a newer %s root',
    async (newerRoot) => {
      const archivedRoot = { ...parent, archived: true, last_updated: '2026-09-01T00:00:01.000Z' };
      const affectedSessions = [child, grandchild, sibling].map((s) => ({
        ...s,
        archived: true,
        last_updated: '2026-09-01T00:00:02.000Z',
      }));
      let resolve!: (value: { session: Session; affectedSessions: Session[] }) => void;
      const response = new Promise<{ session: Session; affectedSessions: Session[] }>((done) => {
        resolve = done;
      });
      const { result } = renderHook(() =>
        useSessionActions(
          makeClient({
            'sessions/parent/archive': { create: () => response },
            sessions: {
              get: async (id: string) =>
                id === parent.session_id
                  ? newerRoot === 'none'
                    ? archivedRoot
                    : restored
                  : affectedSessions.find((s) => s.session_id === id),
            },
          })
        )
      );
      let request!: ReturnType<typeof result.current.archiveSession>;
      act(() => {
        request = result.current.archiveSession(parent.session_id);
      });
      const restored = { ...parent, title: 'Restored', last_updated: '2026-09-01T00:00:03.000Z' };
      if (newerRoot !== 'none') {
        act(() => {
          bumpRevision('sessions');
          enqueueSessionPatch('tenant-a:user-a:1', restored);
          if (newerRoot === 'applied') flushRealtimeNow('tenant-a:user-a:1');
        });
      }
      await act(async () => {
        // The server emits only changed children, never the already-archived root.
        resolve({ session: archivedRoot, affectedSessions });
        expect(await request).toEqual({ session: archivedRoot, reconciliation: 'confirmed' });
      });
      expectActive(
        newerRoot === 'none' ? [unrelated, orphan, remote] : [restored, unrelated, orphan, remote]
      );
      if (newerRoot !== 'none') {
        expect(agorStore.getState().sessionById.get(parent.session_id)).toEqual(restored);
      }
    }
  );

  it('does not remove anything while pending or after an archive failure', async () => {
    let reject!: (error: Error) => void;
    const response = new Promise<never>((_, rejectResponse) => {
      reject = rejectResponse;
    });
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          'sessions/parent/archive': { create: () => response },
        })
      )
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let request!: ReturnType<typeof result.current.archiveSession>;
    act(() => {
      request = result.current.archiveSession(parent.session_id);
    });
    expectActive(sessions);
    await act(async () => {
      reject(new Error('Archive denied'));
      expect(await request).toBeNull();
    });
    expectActive(sessions);
    expect(result.current.error).toBe('Archive denied');
    consoleError.mockRestore();
  });

  it('keeps the batch intact while refetch waits and reports a read failure distinctly', async () => {
    const archived = { ...parent, archived: true };
    let reject!: (error: Error) => void;
    const read = new Promise<Session>((_, fail) => {
      reject = fail;
    });
    const get = vi.fn(() => read);
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          'sessions/parent/archive': { create: async () => ({ session: archived }) },
          sessions: { get },
        })
      )
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let request!: ReturnType<typeof result.current.archiveSession>;
    await act(async () => {
      request = result.current.archiveSession(parent.session_id);
    });
    expect(get).toHaveBeenCalledWith(parent.session_id);
    expectActive(sessions);
    await act(async () => {
      reject(new Error('Offline'));
      expect(await request).toEqual({ session: archived, reconciliation: 'refresh-required' });
    });
    expectActive(sessions);
    expect(result.current.error).toBeNull();
    consoleError.mockRestore();
  });

  it('does not apply a previous tenant authority response to the replacement store', async () => {
    let resolve!: (value: { session: Session; affectedSessions: Session[] }) => void;
    const response = new Promise<{ session: Session; affectedSessions: Session[] }>(
      (resolveResponse) => {
        resolve = resolveResponse;
      }
    );
    const get = vi.fn();
    const { result } = renderHook(() =>
      useSessionActions(
        makeClient({
          'sessions/parent/archive': { create: () => response },
          sessions: { get },
        })
      )
    );
    let request!: ReturnType<typeof result.current.archiveSession>;
    act(() => {
      request = result.current.archiveSession(parent.session_id);
    });
    setRealtimeAuthorityScope('tenant-b:user-b:2');
    // Even identical IDs may not be mutated by a response from the former authority.
    await act(async () => {
      resolve({
        session: { ...parent, archived: true, last_updated: '2026-09-01T00:00:01.000Z' },
        affectedSessions: [{ ...parent, archived: true, last_updated: '2026-09-01T00:00:01.000Z' }],
      });
      await request;
    });
    expect(get).not.toHaveBeenCalled();
    expectActive(sessions);
  });
});
