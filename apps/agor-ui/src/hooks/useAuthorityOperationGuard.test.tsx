import type { AgorClient } from '@agor-live/client';
import { act, render, renderHook } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from './useAuthorityOperationGuard';

describe('useAuthorityOperationGuard', () => {
  it('invalidates an old operation synchronously on an in-place authority render', () => {
    const { result, rerender } = renderHook(
      ({ userId, generation }) => useAuthorityOperationGuard([userId, generation]),
      { initialProps: { userId: 'admin-a', generation: 1 } }
    );
    const operation = result.current.begin();
    expect(operation.isCurrent()).toBe(true);

    rerender({ userId: 'admin-b', generation: 2 });

    expect(operation.isCurrent()).toBe(false);
    expect(result.current.isCurrent()).toBe(true);
  });

  it('notifies an in-flight owner when its generation is invalidated', async () => {
    const { result, rerender } = renderHook(
      ({ generation }) => useAuthorityOperationGuard(['admin-a', generation]),
      { initialProps: { generation: 1 } }
    );
    const operation = result.current.begin();
    const invalidated = vi.fn();
    operation.onInvalidate(invalidated);

    rerender({ generation: 2 });
    expect(operation.isCurrent()).toBe(false);
    await Promise.resolve();
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it('invalidates in layout cleanup for keyed replacement and explicit cancellation', () => {
    const first = renderHook(() => useAuthorityOperationGuard(['admin-a', 1]));
    const operation = first.result.current.begin();
    first.unmount();
    expect(operation.isCurrent()).toBe(false);

    const second = renderHook(() => useAuthorityOperationGuard(['admin-a', 1]));
    const cancelled = second.result.current.begin();
    act(() => cancelled.cancel());
    expect(cancelled.isCurrent()).toBe(false);
  });

  it('keeps operations current when the same authority parts re-render', () => {
    const client = {};
    const { result, rerender } = renderHook(
      ({ label }) => {
        void label;
        return useAuthorityOperationGuard(['admin-a', 1, client]);
      },
      { initialProps: { label: 'before reconnect' } }
    );
    const operation = result.current.begin();
    rerender({ label: 'same caller UI update' });
    expect(operation.isCurrent()).toBe(true);
  });

  it('remains usable after StrictMode replays layout-effect cleanup', () => {
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useAuthorityOperationGuard(['admin-a', 1]), { wrapper });

    expect(result.current.isCurrent()).toBe(true);
    expect(result.current.begin().isCurrent()).toBe(true);
  });

  it('preserves identity scope but cancels operations across disconnect and auth generation', () => {
    const client = {} as AgorClient;
    let current:
      | {
          authority: ReturnType<typeof useAuthenticatedAuthorityScope>;
          guard: ReturnType<typeof useAuthorityOperationGuard>;
        }
      | undefined;
    const Inner = () => {
      const authority = useAuthenticatedAuthorityScope(client, 'admin-a:admin');
      current = { authority, guard: useAuthorityOperationGuard(authority.operationScope) };
      return null;
    };
    const Harness = ({
      connected,
      connecting,
      generation,
    }: {
      connected: boolean;
      connecting: boolean;
      generation: number;
    }) => (
      <ConnectionProvider
        value={{
          connected,
          connecting,
          authGeneration: generation,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <Inner />
      </ConnectionProvider>
    );
    const rendered = render(<Harness connected connecting={false} generation={7} />);
    const old = current!.guard.begin();

    rendered.rerender(<Harness connected connecting generation={7} />);
    expect(old.isCurrent()).toBe(false);
    expect(current!.authority.identityKey).toBe('admin-a:admin');
    expect(current!.authority.operationScope).toBeNull();

    rendered.rerender(<Harness connected connecting={false} generation={8} />);
    expect(current!.authority.identityKey).toBe('admin-a:admin');
    expect(current!.guard.begin().isCurrent()).toBe(true);
  });
});
