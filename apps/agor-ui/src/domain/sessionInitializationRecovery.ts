import type { SessionInitializationResult, SessionInitializationRetry } from './sessionCreation';

/** Caller-owned recovery payloads for sessions whose initialization is incomplete. */
export interface SessionInitializationRecoveryState {
  ownerId: string | null;
  retries: ReadonlyMap<string, SessionInitializationRetry>;
}

export function createSessionInitializationRecoveryState(
  ownerId: string | null
): SessionInitializationRecoveryState {
  return { ownerId, retries: new Map() };
}

/** Switching identity always drops payloads that belonged to the previous caller. */
export function scopeSessionInitializationRecovery(
  state: SessionInitializationRecoveryState,
  ownerId: string | null
): SessionInitializationRecoveryState {
  return state.ownerId === ownerId ? state : createSessionInitializationRecoveryState(ownerId);
}

/**
 * Apply an async initialization result only when its initiating caller still
 * owns the recovery state and the target session still exists.
 */
export function recordSessionInitializationResult(
  state: SessionInitializationRecoveryState,
  operationOwnerId: string,
  outcome: SessionInitializationResult,
  sessionExists: boolean
): SessionInitializationRecoveryState {
  if (state.ownerId !== operationOwnerId) return state;

  const retries = new Map(state.retries);
  if (outcome.status === 'retryable' && sessionExists) {
    retries.set(outcome.sessionId, outcome.retry);
  } else {
    retries.delete(outcome.sessionId);
  }
  return { ...state, retries };
}

/** Remove recovery payloads for sessions deleted locally or by another client. */
export function pruneSessionInitializationRecovery(
  state: SessionInitializationRecoveryState,
  sessionExists: (sessionId: string) => boolean
): SessionInitializationRecoveryState {
  const retries = new Map([...state.retries].filter(([sessionId]) => sessionExists(sessionId)));
  return retries.size === state.retries.size ? state : { ...state, retries };
}

/** Return the canonical in-flight operation for one caller/session key. */
export function runSessionInitializationSingleFlight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  operation: () => Promise<T>,
  onSettled?: (promise: Promise<T>) => void
): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing;

  const promise = operation();
  flights.set(key, promise);
  const settle = () => {
    if (flights.get(key) !== promise) return;
    flights.delete(key);
    onSettled?.(promise);
  };
  void promise.then(settle, settle);
  return promise;
}
