import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { useAuthorityOperationGuard } from './useAuthorityOperationGuard';

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
});
