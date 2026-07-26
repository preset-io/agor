import type { AgorClient, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionActions } from './useSessionActions';

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
    let returned: Session | null = null;
    await act(async () => {
      returned = await result.current.archiveSession('session-1' as Session['session_id']);
    });

    expect(returned).toBe(archivedSession);
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

describe('useSessionActions OpenCode model config', () => {
  it('does not create a detached effort-only model config when selection is omitted', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        modelConfig: undefined,
        effort: 'high',
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
        model_config: undefined,
      })
    );
  });

  it('carries a deliberate clear as model_config null without detached effort', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        modelConfig: null,
        effort: 'high',
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
        model_config: null,
      })
    );
  });

  it('keeps a complete exact OpenCode provider/model pair', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-5' },
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model_config: expect.objectContaining({
          mode: 'exact',
          provider: 'openai',
          model: 'gpt-5',
        }),
      })
    );
  });
});
