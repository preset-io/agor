import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';

const KEY_PREFIX = 'agor-marketplace-oauth-prompt:';
const SUGGESTION_KEY_PREFIX = 'agor-marketplace-prompt-suggestion:';
const MAX_AGE_MS = 60 * 60 * 1000;

export interface MarketplaceOAuthHandoffAuthority {
  userId: string;
  role: string;
  authGeneration: number;
}

export interface PendingMarketplaceOAuthPrompt extends MarketplaceOAuthHandoffAuthority {
  sessionId: string;
  serverId: string;
  attemptId: string;
  popupOperationId: string;
  prompt: string;
  createdAt: number;
}

const key = (sessionId: string) => `${KEY_PREFIX}${sessionId}`;
const suggestionKey = (sessionId: string) => `${SUGGESTION_KEY_PREFIX}${sessionId}`;

type PromptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type AttemptReadOutcome =
  | { kind: 'found'; attempt: MCPOAuthAttemptResult }
  | { kind: 'missing' }
  | { kind: 'transient' };

interface PromptClaimFlight {
  pending: PendingMarketplaceOAuthPrompt;
  outcome: Promise<AttemptReadOutcome>;
  activeClaimants: number;
  retryRequested: boolean;
  consumed: boolean;
  cancelled: boolean;
  finalized: boolean;
}

// A browser tab has one sessionStorage object and one module realm. Key claim
// flights by that object so replacement effects in the same tab can adopt a
// held validation, while distinct tabs (and test storage contexts) can never
// observe or consume each other's operation.
const claimFlightsByStorage = new WeakMap<PromptStorage, Map<string, PromptClaimFlight>>();

function tabStorage(storage?: PromptStorage): PromptStorage {
  return storage ?? sessionStorage;
}

function claimFlights(storage: PromptStorage): Map<string, PromptClaimFlight> {
  let flights = claimFlightsByStorage.get(storage);
  if (!flights) {
    flights = new Map();
    claimFlightsByStorage.set(storage, flights);
  }
  return flights;
}

function remove(sessionId: string, storage?: PromptStorage): void {
  try {
    tabStorage(storage).removeItem(key(sessionId));
  } catch {
    // ignore unavailable storage
  }
}

/** Remove only the handoff created by this exact popup/attempt operation. */
export function discardPendingMarketplaceOAuthPrompt(
  sessionId: string,
  attemptId: string,
  popupOperationId: string,
  storage?: PromptStorage
): void {
  const promptStorage = tabStorage(storage);
  const flight = claimFlights(promptStorage).get(sessionId);
  if (
    flight?.pending.attemptId === attemptId &&
    flight.pending.popupOperationId === popupOperationId
  ) {
    flight.cancelled = true;
    flight.finalized = true;
    claimFlights(promptStorage).delete(sessionId);
  }
  const pending = readPendingMarketplaceOAuthPrompt(sessionId, storage);
  if (pending?.attemptId === attemptId && pending.popupOperationId === popupOperationId) {
    remove(sessionId, storage);
  }
}

/** Nonsecret handoff only; OAuth protocol data and credentials never enter it. */
export function savePendingMarketplaceOAuthPrompt(
  value: PendingMarketplaceOAuthPrompt,
  storage?: PromptStorage
): void {
  try {
    const promptStorage = tabStorage(storage);
    const existingFlight = claimFlights(promptStorage).get(value.sessionId);
    if (
      existingFlight &&
      (existingFlight.pending.attemptId !== value.attemptId ||
        existingFlight.pending.popupOperationId !== value.popupOperationId ||
        !authorityMatches(existingFlight.pending, value))
    ) {
      existingFlight.cancelled = true;
      existingFlight.finalized = true;
      claimFlights(promptStorage).delete(value.sessionId);
    }
    promptStorage.setItem(key(value.sessionId), JSON.stringify(value));
  } catch {
    // OAuth still succeeds; only prompt seeding is skipped.
  }
}

export function readPendingMarketplaceOAuthPrompt(
  sessionId: string,
  storage?: PromptStorage
): PendingMarketplaceOAuthPrompt | null {
  try {
    const raw = tabStorage(storage).getItem(key(sessionId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingMarketplaceOAuthPrompt>;
    if (
      value.sessionId !== sessionId ||
      typeof value.serverId !== 'string' ||
      typeof value.attemptId !== 'string' ||
      typeof value.popupOperationId !== 'string' ||
      typeof value.userId !== 'string' ||
      typeof value.role !== 'string' ||
      typeof value.authGeneration !== 'number' ||
      typeof value.prompt !== 'string' ||
      typeof value.createdAt !== 'number' ||
      Date.now() - value.createdAt > MAX_AGE_MS
    ) {
      remove(sessionId, storage);
      return null;
    }
    return value as PendingMarketplaceOAuthPrompt;
  } catch {
    remove(sessionId, storage);
    return null;
  }
}

/** Attempt-scoped compare-and-delete prevents one flow consuming another. */
export function consumePendingMarketplaceOAuthPrompt(
  sessionId: string,
  attemptId: string,
  storage?: PromptStorage
): PendingMarketplaceOAuthPrompt | null {
  const value = readPendingMarketplaceOAuthPrompt(sessionId, storage);
  if (!value || value.attemptId !== attemptId) return null;
  remove(sessionId, storage);
  return value;
}

function restorePendingMarketplaceOAuthPrompt(
  pending: PendingMarketplaceOAuthPrompt,
  storage: PromptStorage
): void {
  // Never overwrite a newer attempt installed while this status read was in
  // flight. sessionStorage makes this synchronous within the initiating tab.
  if (readPendingMarketplaceOAuthPrompt(pending.sessionId, storage)) return;
  savePendingMarketplaceOAuthPrompt(pending, storage);
}

function authorityMatches(
  pending: PendingMarketplaceOAuthPrompt,
  authority: MarketplaceOAuthHandoffAuthority
): boolean {
  return (
    pending.userId === authority.userId &&
    pending.role === authority.role &&
    pending.authGeneration === authority.authGeneration
  );
}

function finalizeClaimFlight(
  storage: PromptStorage,
  flights: Map<string, PromptClaimFlight>,
  flight: PromptClaimFlight,
  restore: boolean
): void {
  if (flight.finalized) return;
  flight.finalized = true;
  if (flights.get(flight.pending.sessionId) === flight) {
    flights.delete(flight.pending.sessionId);
  }
  if (restore && !flight.cancelled && !flight.consumed) {
    restorePendingMarketplaceOAuthPrompt(flight.pending, storage);
  }
}

function startOrJoinClaimFlight(
  client: AgorClient,
  sessionId: string,
  storage: PromptStorage,
  authority: MarketplaceOAuthHandoffAuthority
): PromptClaimFlight | null {
  const flights = claimFlights(storage);
  const existing = flights.get(sessionId);
  if (existing && !existing.finalized && !existing.cancelled) return existing;

  const pending = readPendingMarketplaceOAuthPrompt(sessionId, storage);
  if (!pending) return null;
  if (!authorityMatches(pending, authority)) {
    remove(sessionId, storage);
    return null;
  }
  remove(sessionId, storage);
  const outcome = Promise.resolve()
    .then(() => client.service('mcp-servers/oauth-attempt-status').get(pending.attemptId))
    .then(
      (attempt: unknown) => ({ kind: 'found', attempt: attempt as MCPOAuthAttemptResult }) as const,
      (cause: unknown) => {
        const error = cause as { code?: number; name?: string };
        return error.code === 404 || error.name === 'NotFound'
          ? ({ kind: 'missing' } as const)
          : ({ kind: 'transient' } as const);
      }
    );
  const flight: PromptClaimFlight = {
    pending,
    outcome,
    activeClaimants: 0,
    retryRequested: false,
    consumed: false,
    cancelled: false,
    finalized: false,
  };
  flights.set(sessionId, flight);
  return flight;
}

/**
 * Resolve a handoff only after both durable authorities agree: the caller's
 * authenticated-server set and this exact OAuth attempt's succeeded row.
 * Terminal cancelled/stale attempts are erased; transient read failures retain
 * the handoff for focus/realtime recovery.
 */
export async function claimMarketplaceOAuthPrompt(input: {
  client: AgorClient;
  sessionId: string;
  authenticatedServerIds: ReadonlySet<string>;
  authority: MarketplaceOAuthHandoffAuthority;
  isCurrent: () => boolean;
  storage?: PromptStorage;
}): Promise<string | null> {
  if (!input.isCurrent()) return null;
  const storage = tabStorage(input.storage);
  const flights = claimFlights(storage);
  const flight = startOrJoinClaimFlight(input.client, input.sessionId, storage, input.authority);
  if (!flight) return null;
  const { pending } = flight;
  if (!authorityMatches(pending, input.authority)) {
    flight.cancelled = true;
    finalizeClaimFlight(storage, flights, flight, false);
    return null;
  }

  flight.activeClaimants += 1;
  let retry = false;
  try {
    const outcome = await flight.outcome;
    if (flight.cancelled || flight.finalized) return null;
    // Effect cancellation is not terminal: a replacement effect/remount with
    // the same authority joins this flight, or the last stale claimant restores
    // the exact handoff for a later remount.
    if (!input.isCurrent()) {
      retry = true;
      return null;
    }
    if (outcome.kind === 'transient') {
      retry = true;
      return null;
    }
    if (outcome.kind === 'missing') {
      finalizeClaimFlight(storage, flights, flight, false);
      return null;
    }
    const { attempt } = outcome;
    if (attempt.attempt_id !== pending.attemptId) {
      finalizeClaimFlight(storage, flights, flight, false);
      return null;
    }
    if (attempt.status === 'succeeded' && attempt.mcp_server_id === pending.serverId) {
      // The attempt row and the authoritative authenticated-server projection
      // can land in either event order. Keep the exact-attempt handoff until both
      // agree, but never let success on another server consume it.
      if (!input.authenticatedServerIds.has(pending.serverId)) {
        retry = true;
        return null;
      }
      if (flight.consumed) return null;
      // Persist presentation state in the same tab before releasing the
      // handoff. If React replaces/unmounts the validating effect in the next
      // microtask, its replacement can still consume this suggestion exactly
      // once. This never touches the cross-tab composer draft.
      saveMarketplacePromptSuggestion(
        { sessionId: pending.sessionId, prompt: pending.prompt, authority: input.authority },
        storage
      );
      flight.consumed = true;
      finalizeClaimFlight(storage, flights, flight, false);
      return pending.prompt;
    }
    if (
      (attempt.status === 'succeeded' && attempt.mcp_server_id !== pending.serverId) ||
      (attempt.status !== 'pending' && attempt.status !== 'exchanging')
    ) {
      finalizeClaimFlight(storage, flights, flight, false);
      return null;
    }
    retry = true;
    return null;
  } finally {
    flight.activeClaimants -= 1;
    if (retry) flight.retryRequested = true;
    if (flight.activeClaimants === 0 && !flight.finalized) {
      finalizeClaimFlight(storage, flights, flight, flight.retryRequested);
    }
  }
}

/**
 * A starter prompt is presentation state, never a composer draft.
 *
 * `sessionStorage` deliberately scopes it to the tab that initiated Connect.
 * The shared `localStorage` draft may be written by any open tab and has no
 * atomic compare-and-set primitive. Keeping Marketplace out of that keyspace
 * is the fail-closed guarantee: an OAuth completion cannot overwrite text,
 * even when another tab writes at the exact final read/write boundary.
 */
export function saveMarketplacePromptSuggestion(
  input: {
    sessionId: string;
    prompt: string;
    authority: MarketplaceOAuthHandoffAuthority;
  },
  storage?: PromptStorage
): void {
  if (!input.prompt.trim()) return;
  try {
    tabStorage(storage).setItem(
      suggestionKey(input.sessionId),
      JSON.stringify({
        sessionId: input.sessionId,
        prompt: input.prompt,
        ...input.authority,
        createdAt: Date.now(),
      })
    );
  } catch {
    // The session remains usable; only the optional suggestion is skipped.
  }
}

export function consumeMarketplacePromptSuggestion(
  sessionId: string,
  authority: MarketplaceOAuthHandoffAuthority,
  storage?: PromptStorage
): string | null {
  try {
    const promptStorage = tabStorage(storage);
    const raw = promptStorage.getItem(suggestionKey(sessionId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingMarketplaceOAuthPrompt>;
    if (
      value.sessionId !== sessionId ||
      value.userId !== authority.userId ||
      value.role !== authority.role ||
      value.authGeneration !== authority.authGeneration ||
      typeof value.prompt !== 'string' ||
      typeof value.createdAt !== 'number' ||
      Date.now() - value.createdAt > MAX_AGE_MS
    ) {
      promptStorage.removeItem(suggestionKey(sessionId));
      return null;
    }
    promptStorage.removeItem(suggestionKey(sessionId));
    return value.prompt;
  } catch {
    try {
      tabStorage(storage).removeItem(suggestionKey(sessionId));
    } catch {
      // ignore unavailable storage
    }
    return null;
  }
}

export function discardMarketplacePromptSuggestion(
  sessionId: string,
  storage?: PromptStorage
): void {
  try {
    tabStorage(storage).removeItem(suggestionKey(sessionId));
  } catch {
    // ignore unavailable storage
  }
}
