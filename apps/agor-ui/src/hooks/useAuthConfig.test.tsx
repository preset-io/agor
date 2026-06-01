import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthConfig } from './useAuthConfig';

describe('useAuthConfig', () => {
  afterEach(() => {
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
            externalLaunch: {
              enabled: true,
              loginRedirectUrl: 'https://workspace.example.com/open',
            },
          },
        }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config?.externalLaunch).toEqual({
      enabled: true,
      loginRedirectUrl: 'https://workspace.example.com/open',
    });
  });
});
