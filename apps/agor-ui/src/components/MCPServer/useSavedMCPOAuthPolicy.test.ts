import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSavedMCPOAuthPolicy } from './useSavedMCPOAuthPolicy';

const initial = {
  mcp_server_id: '01900000-0000-7000-8000-000000000001',
  config_version: 1,
  auth: { type: 'oauth' },
  oauth_compatibility_policy: {
    effective_mode: 'marketplace',
    managed_by_catalog: true,
    effective_dcr_mode: 'advertised',
    dcr_mode_source: 'default',
  },
} as MCPServer;
const raw = {
  ...initial,
  config_version: 2,
  auth: { type: 'oauth', oauth_dcr_mode: 'disabled' },
  oauth_compatibility_policy: undefined,
} as MCPServer;
const projected = {
  ...raw,
  oauth_compatibility_policy: {
    effective_mode: 'strict',
    managed_by_catalog: false,
    effective_dcr_mode: 'disabled',
    dcr_mode_source: 'explicit',
  },
} as MCPServer;

function setup(get = vi.fn<() => Promise<MCPServer>>()) {
  const client = { service: vi.fn(() => ({ get })) } as unknown as AgorClient;
  const props = { server: initial, client, authorityKey: 'user-a:1', open: true };
  const hook = renderHook(useSavedMCPOAuthPolicy, { initialProps: props });
  return { ...hook, props, get };
}

describe('saved MCP OAuth policy reads', () => {
  it('reads a projection-less PATCH/realtime revision without retaining or deriving old policy', async () => {
    let resolve!: (value: MCPServer) => void;
    const get = vi.fn(
      () =>
        new Promise<MCPServer>((done) => {
          resolve = done;
        })
    );
    const { result, rerender, props } = setup(get);
    expect(get).not.toHaveBeenCalled();
    rerender({ ...props, server: raw });
    expect(result.current.policyServer).toBe(raw);
    expect(result.current.policyServer?.oauth_compatibility_policy).toBeUndefined();
    await act(async () => resolve(projected));
    expect(result.current.policyServer).toBe(projected);
    expect(get).toHaveBeenCalledOnce();
    // Equal-version socket replacements have no projection; older ones can
    // arrive after GET too. Neither may erase/regress the authoritative read.
    rerender({ ...props, server: { ...raw } });
    rerender(props);
    expect(result.current.policyServer).toBe(projected);
    expect(get).toHaveBeenCalledOnce();
    // Catalog curation can change a read projection without changing the row's
    // configuration epoch. A newly received projected read wins at that epoch.
    const refreshed = {
      ...projected,
      oauth_compatibility_policy: initial.oauth_compatibility_policy,
    };
    rerender({ ...props, server: refreshed });
    expect(result.current.policyServer).toBe(refreshed);
  });

  it('ignores a delayed read after a newer realtime revision and does not retry forever', async () => {
    let resolve!: (value: MCPServer) => void;
    const get = vi
      .fn<() => Promise<MCPServer>>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      )
      .mockRejectedValueOnce(new Error('offline'));
    const { result, rerender, props } = setup(get);
    rerender({ ...props, server: raw });
    const newer = { ...raw, config_version: 3 };
    rerender({ ...props, server: newer });
    await waitFor(() => expect(result.current.policyUnavailable).toBe(true));
    await act(async () => resolve(projected));
    expect(result.current.policyServer).toBe(newer);
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce({ ...projected, config_version: 3 });
    act(() => result.current.retryPolicy());
    await waitFor(() =>
      expect(result.current.policyServer?.oauth_compatibility_policy).toEqual(
        projected.oauth_compatibility_policy
      )
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([initial, raw])('fails closed on an older or projection-less GET', async (response) => {
    const { result, rerender, props } = setup(vi.fn().mockResolvedValue(response));
    rerender({ ...props, server: raw });
    await waitFor(() => expect(result.current.policyUnavailable).toBe(true));
    expect(result.current.policyServer).toBe(raw);
  });

  it('accepts a GET that observed a concurrent newer save without regressing afterward', async () => {
    const newer = { ...projected, config_version: 4 };
    const { result, rerender, props } = setup(vi.fn().mockResolvedValue(newer));
    rerender({ ...props, server: raw });
    await waitFor(() => expect(result.current.policyServer).toBe(newer));
    rerender({ ...props, server: { ...raw, config_version: 3 } });
    expect(result.current.policyServer).toBe(newer);
  });

  it.each(['close', 'authority', 'client'] as const)(
    'discards reads across %s changes',
    async (change) => {
      let resolve!: (value: MCPServer) => void;
      const get = vi.fn(
        () =>
          new Promise<MCPServer>((done) => {
            resolve = done;
          })
      );
      const { result, rerender, props } = setup(get);
      rerender({ ...props, server: raw });
      rerender({
        ...props,
        server: raw,
        ...(change === 'close'
          ? { open: false }
          : change === 'authority'
            ? { authorityKey: '' }
            : { client: {} as AgorClient }),
      });
      await act(async () => resolve(projected));
      expect(result.current.policyServer?.oauth_compatibility_policy).toBeUndefined();
    }
  );

  it('does not read or keep OAuth policy after switching away from OAuth', () => {
    const { result, rerender, props, get } = setup();
    const noAuth = { ...raw, auth: { type: 'none' as const } };
    rerender({ ...props, server: noAuth });
    expect(result.current.policyServer).toBe(noAuth);
    expect(get).not.toHaveBeenCalled();
  });
});
