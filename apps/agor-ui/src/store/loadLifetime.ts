/**
 * Load lifetime: the one cancellation token every asynchronous store load
 * (first paint, OAuth state refetch, user scope, board partitions) captures
 * BEFORE its first await and checks after every await and before it starts
 * follow-up work (PR #2948's `loadEpoch` contract, shared).
 *
 * Two parts, both required:
 * - the authority scope (identity, role and auth generation) the load started
 *   under, compared with the realtime queue's current authority;
 * - the hydration cancellation epoch, which every cancellation path bumps
 *   (unmount, authority change, logout). An unmount leaves the old hook's
 *   authority unchanged, so the scope alone would let a load suspended across
 *   a remount apply one user's rows into the next user's store.
 *
 * Each caller adds its own generation on top (the user-scope run, a
 * partition's load id) for supersession within one lifetime.
 */
import { getHydrationCancellationEpoch } from './agorHydration';
import { getRealtimeAuthorityScope } from './realtimeBatch';

export interface LoadLifetime {
  /** Authority scope the load started under. */
  readonly authorityScope: string;
  /** Hydration cancellation epoch when the load started. */
  readonly loadEpoch: number;
}

/**
 * Capture the current lifetime; `null` when there is no authority. Call it
 * before the load's first await.
 */
export function captureLoadLifetime(
  authorityScope: string | null = getRealtimeAuthorityScope()
): LoadLifetime | null {
  return authorityScope ? { authorityScope, loadEpoch: getHydrationCancellationEpoch() } : null;
}

/**
 * Whether nothing cancelled the load and its authority is still current.
 * `currentAuthority` defaults to the realtime queue's authority; the data hook
 * passes its render-time authority ref, which moves before the layout phase.
 */
export function isLoadLifetimeCurrent(
  lifetime: LoadLifetime,
  currentAuthority: string | null = getRealtimeAuthorityScope()
): boolean {
  return (
    getHydrationCancellationEpoch() === lifetime.loadEpoch &&
    currentAuthority === lifetime.authorityScope
  );
}

/** The user part of an authority scope (`user:role:generation`). */
export const authorityIdentity = (authorityScope: string) => authorityScope.split(':')[0];
