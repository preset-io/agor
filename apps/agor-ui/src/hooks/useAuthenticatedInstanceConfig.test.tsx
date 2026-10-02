import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type AuthenticatedInstanceConfigOptions,
  useAuthenticatedInstanceConfig,
} from './useAuthenticatedInstanceConfig';

interface Deferred {
  resolve: (value: unknown) => void;
}

function healthClient() {
  const pending: Deferred[] = [];
  const find = vi.fn(
    () =>
      new Promise((resolve) => {
        pending.push({ resolve });
      })
  );
  const client = { service: vi.fn(() => ({ find })) } as unknown as AgorClient;
  return { client, find, pending };
}

function setup(client: AgorClient) {
  let currentGeneration = 1;
  const isAuthenticationGenerationCurrent = (generation: number) =>
    generation === currentGeneration;
  const initialProps: AuthenticatedInstanceConfigOptions = {
    client,
    user: { user_id: 'user-a' as never, role: 'member' },
    connected: true,
    connecting: false,
    authGeneration: 1,
    authenticationGeneration: currentGeneration,
    isAuthenticationGenerationCurrent,
  };
  const hook = renderHook((props) => useAuthenticatedInstanceConfig(props), { initialProps });
  return {
    ...hook,
    props: initialProps,
    /** Mirrors useAuth: logout/authority replacement advances the generation. */
    advanceAuthentication: (overrides: Partial<AuthenticatedInstanceConfigOptions> = {}) => {
      currentGeneration += 1;
      const next = { ...initialProps, authenticationGeneration: currentGeneration, ...overrides };
      hook.rerender(next);
      return next;
    },
  };
}

const health = (label: string) => ({ instance: { label, description: 'Shared' } });

describe('useAuthenticatedInstanceConfig', () => {
  it('reads the authenticated health instance once per authenticated connection', async () => {
    const { client, find, pending } = healthClient();
    const { result, rerender, props } = setup(client);
    expect(find).toHaveBeenCalledOnce();
    await act(async () => pending[0].resolve(health('Acme')));
    expect(result.current).toEqual({ label: 'Acme', description: 'Shared' });

    // Unrelated re-render: no second read.
    rerender({ ...props });
    expect(find).toHaveBeenCalledOnce();

    // Same user/role reconnects: a new socket generation re-reads.
    rerender({ ...props, connecting: true });
    rerender({ ...props, authGeneration: 2 });
    expect(find).toHaveBeenCalledTimes(2);
    await act(async () => pending[1].resolve(health('Renamed')));
    expect(result.current?.label).toBe('Renamed');
  });

  it('discards a response from a superseded connection', async () => {
    const { client, pending } = healthClient();
    const { result, rerender, props } = setup(client);
    rerender({ ...props, authGeneration: 2 });
    await act(async () => pending[0].resolve(health('Old connection')));
    expect(result.current).toBeNull();
    await act(async () => pending[1].resolve(health('Current')));
    expect(result.current?.label).toBe('Current');
  });

  it('clears on logout', async () => {
    const { client, pending } = healthClient();
    const { result, advanceAuthentication } = setup(client);
    await act(async () => pending[0].resolve(health('Acme')));
    expect(result.current?.label).toBe('Acme');

    advanceAuthentication({ user: null, connected: false });
    expect(result.current).toBeNull();
  });

  it('discards a late response that lands after logout', async () => {
    const { client, pending } = healthClient();
    const { result, advanceAuthentication } = setup(client);
    advanceAuthentication({ user: null, connected: false });
    await act(async () => pending[0].resolve(health('Late')));
    expect(result.current).toBeNull();
  });

  it('never shows one authority’s label to the next', async () => {
    const { client, find, pending } = healthClient();
    const { result, advanceAuthentication } = setup(client);
    await act(async () => pending[0].resolve(health('Tenant A')));
    advanceAuthentication({ user: { user_id: 'user-b' as never, role: 'member' } });
    expect(result.current).toBeNull();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await act(async () => pending[1].resolve(health('Tenant B')));
    expect(result.current?.label).toBe('Tenant B');
  });

  it('drops a response whose authentication generation ended without a socket change', async () => {
    const { client, pending } = healthClient();
    let current = true;
    const { result } = renderHook(() =>
      useAuthenticatedInstanceConfig({
        client,
        user: { user_id: 'user-a' as never, role: 'member' },
        connected: true,
        connecting: false,
        authGeneration: 1,
        authenticationGeneration: 1,
        isAuthenticationGenerationCurrent: () => current,
      })
    );
    current = false;
    await act(async () => pending[0].resolve(health('Stale')));
    expect(result.current).toBeNull();
  });
});
