import type { UUID } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type OnboardingOperationOwner, useOnboardingLifecycle } from './useOnboardingLifecycle';

const USER_ID = 'user-1' as UUID;

function defaults() {
  return {
    userId: USER_ID,
    authenticationGeneration: 7,
    eligible: true,
    ready: true,
    completed: false,
    deferred: false,
    isAuthenticationOwnerCurrent: vi.fn(() => true),
  };
}

describe('useOnboardingLifecycle', () => {
  it('makes dismiss terminal despite route, loading, and realtime churn', async () => {
    const input = defaults();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
      { initialProps: input }
    );

    await waitFor(() => expect(result.current.open).toBe(true));
    const owner = result.current.activeOwner!;
    expect(owner.activationGeneration).toBe(1);

    act(() => expect(result.current.defer(owner)).toBe(true));
    expect(result.current.state.phase).toBe('deferred');
    expect(result.current.open).toBe(false);

    // These are the dependencies that historically re-fired App's auto-open
    // effect after a close. The terminal state admits no second activation.
    rerender({ ...input, ready: false });
    rerender({ ...input, ready: true });
    rerender({ ...input, deferred: true });
    rerender({ ...input, deferred: false });
    rerender({ ...input, eligible: false });
    rerender({ ...input, eligible: true });

    expect(result.current.state.phase).toBe('deferred');
    expect(result.current.activeOwner).toBeNull();
    expect(result.current.open).toBe(false);
  });

  it('closes exactly once after completion while the authenticated user stays stale', async () => {
    const input = defaults();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
      { initialProps: input }
    );

    await waitFor(() => expect(result.current.open).toBe(true));
    const owner = result.current.activeOwner!;
    act(() => expect(result.current.complete(owner)).toBe(true));

    // The durable write succeeded, but the login-time user object still says
    // onboarding_completed=false. No ready/route cycle may reopen the modal.
    rerender({ ...input, completed: false, ready: false });
    rerender({ ...input, completed: false, ready: true });

    expect(result.current.state.phase).toBe('completed');
    expect(result.current.open).toBe(false);
    expect(owner.activationGeneration).toBe(1);
  });

  it('treats another-tab completion as close-only and never reopens from a later stale false', async () => {
    const input = defaults();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
      { initialProps: input }
    );

    await waitFor(() => expect(result.current.open).toBe(true));
    const owner = result.current.activeOwner!;
    rerender({ ...input, completed: true });
    await waitFor(() => expect(result.current.open).toBe(false));
    expect(result.current.state.phase).toBe('completed');

    // The same activation's completion operation may still be unwinding after its
    // PATCH triggered that realtime terminal update. Its terminal ack remains
    // current so post-commit navigation can run exactly once.
    expect(result.current.complete(owner)).toBe(true);

    // A lagging auth refresh may still publish false. The lifecycle has already
    // observed a durable terminal true, so false is never an instruction to open.
    rerender({ ...input, completed: false });
    expect(result.current.state.phase).toBe('completed');
    expect(result.current.open).toBe(false);
  });

  it('does not turn an explicit dismissal into completion for post-commit navigation', async () => {
    const input = defaults();
    const { result } = renderHook(() => useOnboardingLifecycle(input));

    await waitFor(() => expect(result.current.open).toBe(true));
    const owner = result.current.activeOwner!;
    act(() => expect(result.current.defer(owner)).toBe(true));

    expect(result.current.complete(owner)).toBe(false);
    expect(result.current.state.phase).toBe('deferred');
  });

  it.each(['completed', 'deferred'] as const)(
    'never revalidates an old %s activation after a newer activation completes',
    async (firstTerminalPhase) => {
      const input = defaults();
      const { result, rerender } = renderHook(
        (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
        { initialProps: input }
      );

      await waitFor(() => expect(result.current.open).toBe(true));
      const firstOwner = result.current.activeOwner!;

      if (firstTerminalPhase === 'completed') {
        // Model the completion PATCH's realtime event arriving while its
        // response remains pending.
        rerender({ ...input, completed: true });
        await waitFor(() => expect(result.current.state.phase).toBe('completed'));
      } else {
        act(() => expect(result.current.defer(firstOwner)).toBe(true));
      }

      let secondOwner: OnboardingOperationOwner | null = null;
      act(() => {
        secondOwner = result.current.activate(USER_ID, 7, true);
      });
      expect(secondOwner?.activationGeneration).toBe(2);
      act(() => expect(result.current.complete(secondOwner!)).toBe(true));

      // The terminal state belongs to activation B. A's delayed response must
      // not navigate to A's board/session behind the newer activation.
      expect(result.current.complete(firstOwner)).toBe(false);
      expect(result.current.state).toEqual({ phase: 'completed', owner: secondOwner });
    }
  );

  it('honors durable terminal gates and viewer restrictions', async () => {
    const input = defaults();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
      { initialProps: { ...input, deferred: true } }
    );

    expect(result.current.open).toBe(false);
    rerender({ ...input, deferred: false, completed: true });
    expect(result.current.open).toBe(false);
    rerender({ ...input, completed: false, eligible: false });
    expect(result.current.open).toBe(false);

    rerender({ ...input, eligible: true });
    await waitFor(() => expect(result.current.open).toBe(true));
  });

  it('allows only an explicit Settings restart to replace a terminal state', async () => {
    const input = defaults();
    const { result } = renderHook(() => useOnboardingLifecycle(input));
    await waitFor(() => expect(result.current.open).toBe(true));
    const first = result.current.activeOwner!;

    act(() => result.current.defer(first));
    expect(result.current.activate(USER_ID, 7)).toBeNull();

    let restarted: ReturnType<typeof result.current.activate> = null;
    act(() => {
      restarted = result.current.activate(USER_ID, 7, true);
    });
    expect(restarted?.activationGeneration).toBe(2);
    expect(result.current.open).toBe(true);
  });

  it('retires an old owner on authenticated identity generation change', async () => {
    const input = defaults();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof defaults>) => useOnboardingLifecycle(props),
      { initialProps: input }
    );
    await waitFor(() => expect(result.current.open).toBe(true));
    const oldOwner = result.current.activeOwner!;

    input.isAuthenticationOwnerCurrent.mockImplementation(
      (_userId, generation) => generation === 8
    );
    rerender({ ...input, authenticationGeneration: 8 });

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.activeOwner?.authenticationGeneration).toBe(8);
    expect(result.current.activeOwner?.activationGeneration).toBe(2);
    expect(result.current.isOwnerCurrent(oldOwner)).toBe(false);
  });
});
