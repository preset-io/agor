import type { AgorClient, Session } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionActions } from './useSessionActions';

describe('OpenCode session creation (real browser)', () => {
  it('submits one exact fictional provider/model pair to the sessions service', async () => {
    const session = {
      session_id: 'fictional-opencode-session',
      branch_id: 'fictional-branch',
      agentic_tool: 'opencode',
      status: 'idle',
    } as Session;
    const create = vi.fn(async () => session);
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'sessions') return { create };
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as AgorClient;
    const { result } = renderHook(() => useSessionActions(client));

    await act(async () => {
      await expect(
        result.current.createSession({
          branch_id: 'fictional-branch',
          agent: 'opencode',
          modelConfig: { mode: 'exact', provider: 'opencode', model: 'big-pickle' },
        })
      ).resolves.toBe(session);
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
        branch_id: 'fictional-branch',
        model_config: expect.objectContaining({
          mode: 'exact',
          provider: 'opencode',
          model: 'big-pickle',
        }),
      })
    );
  });
});
