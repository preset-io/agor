import type { MCPDiscoveryResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMCPServerDiscovery } from './useMCPServerDiscovery';

const discovered: MCPDiscoveryResult = {
  success: true,
  capabilities: { tools: 1, resources: 0, prompts: 0 },
  metadata: { descriptions_truncated: 1 },
  tools: [{ name: 'search' }],
  resources: [],
  prompts: [],
};
function harness(discover = vi.fn().mockResolvedValue(discovered)) {
  const reserve = vi.fn().mockResolvedValue({
    reservation_token: 'fictional-reservation',
    expires_at: Date.now() + 60_000,
  });
  const client = {
    service: vi.fn((path: string) => ({
      create: path === 'mcp-servers/discover' ? discover : reserve,
    })),
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const options = {
    client,
    authorityKey: 'user-a:admin:1' as string | null,
    currentUserId: 'user-a',
    authGeneration: 1,
    formRevision: 0,
    contextKey: 'server-a',
  };
  const hook = renderHook((props) => useMCPServerDiscovery(props), { initialProps: options });
  return { ...hook, options, discover, reserve };
}
describe('MCP discovery form lifecycle', () => {
  it('preserves the canonical metadata in the displayed result', async () => {
    const h = harness();
    await act(() => h.result.current.testConnection(async () => ({ mcp_server_id: 'server-a' })));
    expect(h.result.current.testResult).toEqual(discovered);
    expect(h.result.current.testing).toBe(false);
    expect(h.reserve).toHaveBeenCalledWith({ operation: 'discover', mcp_server_id: 'server-a' });
  });
  it.each(['draft', 'server', 'identity', 'close'] as const)(
    'drops a delayed response after %s changes',
    async (change) => {
      let resolve!: (value: MCPDiscoveryResult) => void;
      const h = harness(
        vi.fn(
          () =>
            new Promise<MCPDiscoveryResult>((done) => {
              resolve = done;
            })
        )
      );
      let pending!: Promise<void>;
      act(() => {
        pending = h.result.current.testConnection(async () => ({ mcp_server_id: 'server-a' }));
      });
      await waitFor(() => expect(h.discover).toHaveBeenCalledOnce());
      h.rerender({
        ...h.options,
        ...(change === 'draft'
          ? { formRevision: 1 }
          : change === 'server'
            ? { contextKey: 'server-b' }
            : change === 'identity'
              ? { authorityKey: 'user-b:admin:2', currentUserId: 'user-b', authGeneration: 2 }
              : { authorityKey: null }),
      });
      await act(async () => {
        resolve(discovered);
        await pending;
      });
      expect(h.result.current.testResult).toBeNull();
      expect(h.result.current.testing).toBe(false);
    }
  );
  it('does not dispatch without authority or after failed preparation', async () => {
    const h = harness();
    await act(() => h.result.current.testConnection(async () => null));
    expect(h.reserve).not.toHaveBeenCalled();
    h.rerender({ ...h.options, authorityKey: null });
    const prepare = vi.fn();
    await act(() => h.result.current.testConnection(prepare));
    expect(prepare).not.toHaveBeenCalled();
    expect(h.discover).not.toHaveBeenCalled();
  });
  it('does not expose raw transport errors', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('fictional-secret-response')));
    await act(() =>
      h.result.current.testConnection(async () => ({ url: 'https://example.test/mcp' }))
    );
    expect(h.result.current.testResult).toEqual({
      success: false,
      error: 'Connection test failed. Check the saved configuration and try again.',
    });
  });
});
