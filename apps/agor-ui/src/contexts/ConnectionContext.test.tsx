import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ConnectionProvider, useConnectionDisabled, useMutationGate } from './ConnectionContext';

function wrapperFor(value: Partial<Parameters<typeof ConnectionProvider>[0]['value']>) {
  return ({ children }: { children: ReactNode }) => (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        tenantRestricted: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
        ...value,
      }}
    >
      {children}
    </ConnectionProvider>
  );
}

describe('mutation gate while the workspace is suspended', () => {
  it('blocks every mutation site — composer, terminal and upload alike', () => {
    const wrapper = wrapperFor({ tenantRestricted: true });
    const { result } = renderHook(() => useMutationGate(), { wrapper });

    expect(result.current).toEqual({
      canMutate: false,
      reason: 'suspended',
      message: 'This workspace is suspended.',
    });
    expect(renderHook(() => useConnectionDisabled(), { wrapper }).result.current).toBe(true);
  });

  it('reports suspension rather than a connection problem it would recover from', () => {
    // A live-looking socket state must not win here: nothing will succeed and
    // "Reconnecting…" would promise a reconnect the client is not attempting.
    const { result } = renderHook(() => useMutationGate(), {
      wrapper: wrapperFor({ tenantRestricted: true, connecting: true, outOfSync: true }),
    });

    expect(result.current.reason).toBe('suspended');
  });

  it('leaves an unrestricted workspace mutable', () => {
    const { result } = renderHook(() => useMutationGate(), { wrapper: wrapperFor({}) });

    expect(result.current).toEqual({ canMutate: true, reason: null, message: null });
  });
});
