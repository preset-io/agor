import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, IdentityContractState, useAuthConfig } from './useAuthConfig';

describe('useAuthConfig', () => {
  afterEach(() => {
    __resetAuthConfigForTests();
    vi.unstubAllGlobals();
  });

  it('accepts safe local password requirements from health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          auth: {
            requireAuth: true,
            identity: {
              contractVersion: 1,
              userLifecycle: 'internal',
              roleAuthority: 'internal',
              localAuth: 'enabled',
              capabilities: {
                users: {
                  create: true,
                  delete: true,
                  identityWrite: true,
                  roleWrite: true,
                  passwordWrite: true,
                  avatarSettingsWrite: true,
                  selfConfigurationWrite: true,
                },
              },
            },
            passwordPolicy: {
              profile: 'secure',
              min_length: 15,
              max_utf8_bytes: 72,
              common_passwords_rejected: true,
              composition_rules: false,
              periodic_rotation_required: false,
            },
          },
        }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config?.passwordPolicy).toMatchObject({
      profile: 'secure',
      min_length: 15,
      max_utf8_bytes: 72,
    });
    expect(result.current.identityContractState).toBe(IdentityContractState.SUPPORTED);
  });

  it('fails closed when disabled local auth advertises a password policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          auth: {
            requireAuth: true,
            identity: {
              contractVersion: 1,
              userLifecycle: 'external',
              roleAuthority: 'claims',
              localAuth: 'disabled',
              external: { provider: 'external_launch', provisioning: 'jit' },
              capabilities: {
                users: {
                  create: false,
                  delete: false,
                  identityWrite: false,
                  roleWrite: false,
                  passwordWrite: false,
                  avatarSettingsWrite: false,
                  selfConfigurationWrite: true,
                },
              },
            },
            passwordPolicy: {
              profile: 'secure',
              min_length: 15,
              max_utf8_bytes: 72,
              common_passwords_rejected: true,
              composition_rules: false,
              periodic_rotation_required: false,
            },
          },
        }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toBeNull();
    expect(result.current.error?.message).toMatch(/disabled local authentication/);
    expect(result.current.identityContractState).toBe(IdentityContractState.UNSUPPORTED);
  });

  it('reads external launch redirect config from health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: Date.now(),
          version: 'test',
          database: 'sqlite',
          auth: {
            requireAuth: true,
            identity: {
              contractVersion: 1,
              userLifecycle: 'external',
              roleAuthority: 'claims',
              localAuth: 'disabled',
              external: { provider: 'external_launch', provisioning: 'jit' },
              capabilities: {
                users: {
                  create: false,
                  delete: false,
                  identityWrite: false,
                  roleWrite: false,
                  passwordWrite: false,
                  avatarSettingsWrite: false,
                  selfConfigurationWrite: true,
                },
              },
            },
            externalLaunch: {
              enabled: true,
              loginRedirectUrl: 'https://workspace.example.com/open',
            },
          },
        }),
      }))
    );

    const fetchMock = vi.mocked(fetch);
    const { result } = renderHook(() => [useAuthConfig(), useAuthConfig()] as const);

    await waitFor(() => expect(result.current[0].loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe(result.current[1]);
    expect(result.current[0].config?.externalLaunch).toEqual({
      enabled: true,
      loginRedirectUrl: 'https://workspace.example.com/open',
    });
    expect(result.current[0].config?.identity).toMatchObject({
      contractVersion: 1,
      userLifecycle: 'external',
      roleAuthority: 'claims',
      localAuth: 'disabled',
      external: { provider: 'external_launch', provisioning: 'jit' },
      capabilities: { users: { create: false, selfConfigurationWrite: true } },
    });
    expect(result.current[0].identityContractState).toBe(IdentityContractState.SUPPORTED);
  });

  it('exposes the branch RBAC feature gate from public health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          auth: { requireAuth: true },
          features: { branchRbac: false },
        }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.featuresConfig?.branchRbac).toBe(false);
  });

  it('permits a legacy health response only when the identity contract is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ auth: { requireAuth: true } }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toEqual({ requireAuth: true });
    expect(result.current.error).toBeNull();
    expect(result.current.identityContractState).toBe(IdentityContractState.LEGACY);
  });

  it.each([
    ['future', { contractVersion: 2 }],
    [
      'malformed',
      {
        contractVersion: 1,
        userLifecycle: 'external',
        roleAuthority: 'claims',
        localAuth: 'disabled',
        capabilities: { users: { create: false } },
      },
    ],
  ])('fails closed for a %s identity capability contract', async (_label, identity) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ auth: { requireAuth: true, identity } }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toBeNull();
    expect(result.current.error?.message).toMatch(/identity capability contract/i);
    expect(result.current.identityContractState).toBe(IdentityContractState.UNSUPPORTED);
  });

  it('retries in the mounted app shell without synthesizing local-login config', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, statusText: 'Unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { requireAuth: true } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.config).toBeNull();
    expect(result.current.error).not.toBeNull();

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.config).toEqual({ requireAuth: true }));
    expect(result.current.error).toBeNull();
    expect(result.current.identityContractState).toBe(IdentityContractState.LEGACY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
