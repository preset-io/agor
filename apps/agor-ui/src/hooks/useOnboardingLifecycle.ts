import type { UUID } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One activation of the onboarding wizard, owned by an exact authenticated
 * user generation. The opaque activation generation prevents a continuation
 * retained by an older mount from becoming current again.
 */
export interface OnboardingOperationOwner {
  userId: UUID;
  authenticationGeneration: number;
  activationGeneration: number;
}

interface OnboardingAuthorityOwner {
  userId: UUID;
  authenticationGeneration: number;
}

export type OnboardingLifecycleState =
  | { phase: 'idle' }
  | { phase: 'active'; owner: OnboardingOperationOwner; explicit: boolean }
  | { phase: 'deferred' | 'completed'; authority: OnboardingAuthorityOwner };

interface UseOnboardingLifecycleInput {
  userId?: UUID | null;
  authenticationGeneration: number;
  eligible: boolean;
  ready: boolean;
  completed: boolean;
  deferred: boolean;
  isAuthenticationOwnerCurrent: (userId: UUID, generation: number) => boolean;
}

function sameOperationOwner(
  left: OnboardingOperationOwner | null | undefined,
  right: OnboardingOperationOwner | null | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.userId === right.userId &&
      left.authenticationGeneration === right.authenticationGeneration &&
      left.activationGeneration === right.activationGeneration)
  );
}

function sameAuthority(
  left: OnboardingAuthorityOwner | null | undefined,
  right: OnboardingAuthorityOwner | null | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.userId === right.userId &&
      left.authenticationGeneration === right.authenticationGeneration)
  );
}

/**
 * Owns every onboarding visibility transition. In particular, `deferred` and
 * `completed` are terminal for one authentication generation: readiness,
 * route, loading, and realtime churn cannot turn either state back into
 * `active`. A Settings restart is the one explicit replacement transition.
 */
export function useOnboardingLifecycle({
  userId,
  authenticationGeneration,
  eligible,
  ready,
  completed,
  deferred,
  isAuthenticationOwnerCurrent,
}: UseOnboardingLifecycleInput) {
  const [state, setState] = useState<OnboardingLifecycleState>({ phase: 'idle' });
  const stateRef = useRef<OnboardingLifecycleState>(state);
  const activationSequenceRef = useRef(0);

  const commitState = useCallback((next: OnboardingLifecycleState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const activate = useCallback(
    (nextUserId: UUID, nextAuthenticationGeneration: number, replaceActive = false) => {
      const current = stateRef.current;
      const authority = {
        userId: nextUserId,
        authenticationGeneration: nextAuthenticationGeneration,
      };

      if (!replaceActive) {
        if (
          current.phase === 'active' &&
          current.owner.userId === nextUserId &&
          current.owner.authenticationGeneration === nextAuthenticationGeneration
        ) {
          return current.owner;
        }
        if (
          (current.phase === 'deferred' || current.phase === 'completed') &&
          sameAuthority(current.authority, authority)
        ) {
          return null;
        }
      }

      activationSequenceRef.current += 1;
      const owner: OnboardingOperationOwner = {
        ...authority,
        activationGeneration: activationSequenceRef.current,
      };
      commitState({ phase: 'active', owner, explicit: replaceActive });
      return owner;
    },
    [commitState]
  );

  const isOwnerCurrent = useCallback(
    (owner: OnboardingOperationOwner) => {
      const current = stateRef.current;
      return (
        current.phase === 'active' &&
        sameOperationOwner(current.owner, owner) &&
        isAuthenticationOwnerCurrent(owner.userId, owner.authenticationGeneration)
      );
    },
    [isAuthenticationOwnerCurrent]
  );

  const transitionTo = useCallback(
    (owner: OnboardingOperationOwner, phase: 'deferred' | 'completed') => {
      const current = stateRef.current;
      const authority = {
        userId: owner.userId,
        authenticationGeneration: owner.authenticationGeneration,
      };

      // Terminal acknowledgement is idempotent for the same authenticated
      // authority. In particular, the users realtime `onboarding_completed`
      // event can close an automatically-opened wizard while the completion
      // PATCH promise is still resolving. The caller that issued that PATCH
      // must still be allowed to finish its post-commit navigation. A different
      // terminal phase (explicit dismissal) remains authoritative and returns
      // false, so closing during an in-flight write never navigates behind the
      // user's back.
      if (
        current.phase === phase &&
        sameAuthority(current.authority, authority) &&
        isAuthenticationOwnerCurrent(owner.userId, owner.authenticationGeneration)
      ) {
        return true;
      }
      if (!isOwnerCurrent(owner)) return false;
      commitState({
        phase,
        authority,
      });
      return true;
    },
    [commitState, isAuthenticationOwnerCurrent, isOwnerCurrent]
  );

  const defer = useCallback(
    (owner: OnboardingOperationOwner) => transitionTo(owner, 'deferred'),
    [transitionTo]
  );
  const complete = useCallback(
    (owner: OnboardingOperationOwner) => transitionTo(owner, 'completed'),
    [transitionTo]
  );

  const reset = useCallback(() => {
    if (stateRef.current.phase !== 'idle') commitState({ phase: 'idle' });
  }, [commitState]);

  useEffect(() => {
    if (!userId) {
      reset();
      return;
    }

    const current = stateRef.current;
    const authority = { userId, authenticationGeneration };

    if (!eligible) {
      // A role downgrade closes an active wizard, but it must not erase a
      // completion/deferral already recorded for this authority generation.
      // Otherwise a later realtime role correction could reopen from a stale
      // login-time completion bit.
      if (
        !(
          (current.phase === 'deferred' || current.phase === 'completed') &&
          sameAuthority(current.authority, authority)
        )
      ) {
        reset();
      }
      return;
    }

    const currentAutomaticOwner =
      current.phase === 'active' &&
      !current.explicit &&
      current.owner.userId === userId &&
      current.owner.authenticationGeneration === authenticationGeneration
        ? current.owner
        : null;

    // A durable terminal update from this tab or another tab closes only an
    // automatically-opened wizard. Settings can explicitly restart onboarding
    // even for a user whose completion bit remains true.
    if (completed && currentAutomaticOwner) {
      transitionTo(currentAutomaticOwner, 'completed');
      return;
    }
    if (deferred && currentAutomaticOwner) {
      transitionTo(currentAutomaticOwner, 'deferred');
      return;
    }
    if (!ready || completed || deferred) return;

    activate(userId, authenticationGeneration);
  }, [
    activate,
    authenticationGeneration,
    completed,
    deferred,
    eligible,
    ready,
    reset,
    transitionTo,
    userId,
  ]);

  const activeOwner = state.phase === 'active' ? state.owner : null;
  const open = !!activeOwner && isOwnerCurrent(activeOwner);

  return {
    state,
    activeOwner,
    open,
    activate,
    isOwnerCurrent,
    defer,
    complete,
    reset,
  };
}
