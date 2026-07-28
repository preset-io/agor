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
  it('serializes a live reference without inline model or permission fields', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        agenticToolPresetId: '__user_default__',
        modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-5' },
        permissionMode: 'yolo',
      });
    });

    expect(create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        agentic_tool_preset_id: '__user_default__',
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('model_config');
    expect(create.mock.calls[0][0]).not.toHaveProperty('permission_config');
  });

  it('preserves an omitted permission override for daemon-side inheritance', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        modelConfig: undefined,
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('permission_config');
  });

  it.each([
    'autoEdit',
    'yolo',
  ] as const)('serializes an explicit %s permission override', async (permissionMode) => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'opencode',
        modelConfig: undefined,
        permissionMode,
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission_config: { mode: permissionMode },
      })
    );
  });

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
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('model_config');
  });

  it('omits an absent OpenCode override without detached effort', async () => {
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
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('model_config');
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

describe('useSessionActions Codex permission config', () => {
  it('preserves explicit mode, sandbox, approval, and network choices', async () => {
    const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
    const client = makeClient({ sessions: { create } });
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await result.current.createSession({
        branch_id: 'branch-1',
        agent: 'codex',
        permissionMode: 'ask',
        codexSandboxMode: 'danger-full-access',
        codexApprovalPolicy: 'on-request',
        codexNetworkAccess: true,
      });
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission_config: {
          mode: 'ask',
          codex: {
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'on-request',
            networkAccess: true,
          },
        },
      })
    );
  });
});
