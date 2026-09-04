import type { AgorClient, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type SessionArchiveOutcome, useSessionActions } from './useSessionActions';

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
  const outcome = (session: Session) => ({
    session,
    dryRun: false,
    wouldChangeCount: 1,
    archivedCount: 1,
    unarchivedCount: 0,
    localCount: 1,
    remoteCount: 0,
    skippedCount: 0,
    runningCount: 0,
    units: [],
    remainingArchived: [],
  });

  it('archives through the cascade archive route with explicit cascade options', async () => {
    const archivedSession = { session_id: 'session-1', archived: true } as Session;
    const archiveOutcome = outcome(archivedSession);
    const archiveCreate = vi.fn(async () => archiveOutcome);
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/archive': { create: archiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: SessionArchiveOutcome | null = null;
    await act(async () => {
      returned = await result.current.archiveSession('session-1' as Session['session_id']);
    });
    await act(async () => {
      await result.current.archiveSession('session-1' as Session['session_id'], {
        includeRemoteChildren: false,
      });
    });

    expect(returned).toBe(archiveOutcome);
    expect(archiveCreate).toHaveBeenNthCalledWith(1, {
      includeChildren: true,
      includeRemoteChildren: true,
      dryRun: false,
    });
    expect(archiveCreate).toHaveBeenNthCalledWith(2, {
      includeChildren: true,
      includeRemoteChildren: false,
      dryRun: false,
    });
    expect(sessionsPatch).not.toHaveBeenCalled();
  });

  it('unarchives through the cascade unarchive route instead of generic sessions.patch', async () => {
    const unarchivedSession = { session_id: 'session-1', archived: false } as Session;
    const unarchiveOutcome = outcome(unarchivedSession);
    const unarchiveCreate = vi.fn(async () => unarchiveOutcome);
    const sessionsPatch = vi.fn();
    const client = makeClient({
      'sessions/session-1/unarchive': { create: unarchiveCreate },
      sessions: { patch: sessionsPatch },
    });

    const { result } = renderHook(() => useSessionActions(client));
    let returned: SessionArchiveOutcome | null = null;
    await act(async () => {
      returned = await result.current.unarchiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toBe(unarchiveOutcome);
    expect(unarchiveCreate).toHaveBeenCalledWith({
      includeChildren: true,
      includeRemoteChildren: true,
      dryRun: false,
    });
    expect(sessionsPatch).not.toHaveBeenCalled();
  });
});

it('propagates archive failures so callers can offer a targeted retry', async () => {
  const failure = new Error("You need 'prompt' permission to archive sessions in this branch.");
  const client = makeClient({
    'sessions/session-1/archive': { create: vi.fn(async () => Promise.reject(failure)) },
  });
  const { result } = renderHook(() => useSessionActions(client));

  await act(async () => {
    await expect(
      result.current.archiveSession('session-1' as Session['session_id'], { dryRun: true })
    ).rejects.toBe(failure);
  });
  expect(result.current.error).toBe(failure.message);
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
