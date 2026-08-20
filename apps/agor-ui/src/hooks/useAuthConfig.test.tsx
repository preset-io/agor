import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, useAuthConfig } from './useAuthConfig';

describe('useAuthConfig', () => {
  afterEach(() => {
    __resetAuthConfigForTests();
    vi.unstubAllGlobals();
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
      capabilities: { users: { create: false, selfConfigurationWrite: true } },
    });
  });
});
