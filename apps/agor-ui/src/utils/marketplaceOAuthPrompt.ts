import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';

const KEY_PREFIX = 'agor-marketplace-oauth-prompt:';
const SUGGESTION_KEY_PREFIX = 'agor-marketplace-prompt-suggestion:';
const ATTEMPT_KEY_PREFIX = 'agor-marketplace-prompt-attempt:';
const PROMPT_STATE_EVENT = 'agor:marketplace-prompt-state-changed';
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

export interface MarketplacePromptSuggestionState extends MarketplaceOAuthHandoffAuthority {
  sessionId: string;
  attemptId: string;
  prompt: string;
  createdAt: number;
}

export interface MarketplacePromptAttemptMarker extends MarketplaceOAuthHandoffAuthority {
  sessionId: string;
  attemptId: string;
  createdAt: number;
}

const key = (sessionId: string) => `${KEY_PREFIX}${sessionId}`;
const suggestionKey = (sessionId: string) => `${SUGGESTION_KEY_PREFIX}${sessionId}`;
const attemptKey = (sessionId: string) => `${ATTEMPT_KEY_PREFIX}${sessionId}`;

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

interface MemoryAttemptMarker {
  marker: MarketplacePromptAttemptMarker;
  /** Whether this exact marker was durably mirrored to sessionStorage. */
  persisted: boolean;
}

interface MarketplacePromptTabMemory {
  attemptMarkersByStorage: WeakMap<PromptStorage, Map<string, MemoryAttemptMarker>>;
  claimFlightsByStorage: WeakMap<PromptStorage, Map<string, PromptClaimFlight>>;
  revision: number;
}

// Keep the security fence across Vite HMR module replacement. A full page
// reload reconstructs it from sessionStorage; entries whose write failed are
// intentionally memory-only for the remainder of this tab realm.
const TAB_MEMORY_KEY = Symbol.for('agor.marketplace-prompt-tab-memory.v2');
const tabMemoryGlobal = globalThis as typeof globalThis & {
  [TAB_MEMORY_KEY]?: MarketplacePromptTabMemory;
};
function getPromptTabMemory(): MarketplacePromptTabMemory {
  const existing = tabMemoryGlobal[TAB_MEMORY_KEY];
  if (existing) return existing;
  const created: MarketplacePromptTabMemory = {
    attemptMarkersByStorage: new WeakMap(),
    claimFlightsByStorage: new WeakMap(),
    revision: 0,
  };
  tabMemoryGlobal[TAB_MEMORY_KEY] = created;
  return created;
}
const promptTabMemory = getPromptTabMemory();

// A browser tab has one sessionStorage object. Key claim flights by that
// object so replacement effects (including across HMR) can adopt or cancel a
// held validation, while distinct tabs and test storage contexts can never
// observe or consume each other's operation.
function tabStorage(storage?: PromptStorage): PromptStorage {
  return storage ?? sessionStorage;
}

function claimFlights(storage: PromptStorage): Map<string, PromptClaimFlight> {
  let flights = promptTabMemory.claimFlightsByStorage.get(storage);
  if (!flights) {
    flights = new Map();
    promptTabMemory.claimFlightsByStorage.set(storage, flights);
  }
  return flights;
}

function memoryAttemptMarkers(storage: PromptStorage): Map<string, MemoryAttemptMarker> {
  let markers = promptTabMemory.attemptMarkersByStorage.get(storage);
  if (!markers) {
    markers = new Map();
    promptTabMemory.attemptMarkersByStorage.set(storage, markers);
  }
  return markers;
}

function notifyPromptStateChanged(storage: PromptStorage): void {
  if (typeof window === 'undefined') return;
  try {
    // Custom storage objects model separate tabs in tests. Only the actual
    // initiating tab's sessionStorage should wake its mounted SessionPanel.
    if (storage !== window.sessionStorage) return;
  } catch {
    return;
  }
  try {
    promptTabMemory.revision += 1;
    window.dispatchEvent(new Event(PROMPT_STATE_EVENT));
  } catch {
    // Presentation invalidation must never break Connect/logout.
  }
}

/** React external-store bridge for synchronous same-tab attempt fencing. */
export function subscribeMarketplacePromptState(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(PROMPT_STATE_EVENT, listener);
  return () => window.removeEventListener(PROMPT_STATE_EVENT, listener);
}

export function getMarketplacePromptStateRevision(): number {
  return promptTabMemory.revision;
}

function remove(sessionId: string, storage?: PromptStorage): void {
  try {
    const promptStorage = tabStorage(storage);
    promptStorage.removeItem(key(sessionId));
    notifyPromptStateChanged(promptStorage);
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
  let promptStorage: PromptStorage;
  try {
    promptStorage = tabStorage(storage);
  } catch {
    return;
  }
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
  let promptStorage: PromptStorage | undefined;
  try {
    promptStorage = tabStorage(storage);
    const existingFlight = claimFlights(promptStorage).get(value.sessionId);
    if (
      existingFlight &&
      authorityMatches(existingFlight.pending, value) &&
      (existingFlight.pending.attemptId !== value.attemptId ||
        existingFlight.pending.popupOperationId !== value.popupOperationId)
    ) {
      existingFlight.cancelled = true;
      existingFlight.finalized = true;
      claimFlights(promptStorage).delete(value.sessionId);
    }
    installMarketplacePromptAttempt(value, promptStorage);
    promptStorage.setItem(key(value.sessionId), JSON.stringify(value));
  } catch {
    // OAuth still succeeds; only prompt seeding is skipped.
  } finally {
    if (promptStorage) notifyPromptStateChanged(promptStorage);
  }
}

function installMarketplacePromptAttempt(
  value: MarketplacePromptAttemptMarker,
  promptStorage: PromptStorage
): void {
  const marker: MarketplacePromptAttemptMarker = {
    sessionId: value.sessionId,
    attemptId: value.attemptId,
    userId: value.userId,
    role: value.role,
    authGeneration: value.authGeneration,
    createdAt: value.createdAt,
  };
  const memoryMarkers = memoryAttemptMarkers(promptStorage);
  // This assignment is the authoritative synchronous fence. It must happen
  // before *any* storage read/write that can throw, otherwise a quota or
  // read-only failure could leave an earlier suggestion actionable.
  const memoryEntry: MemoryAttemptMarker = { marker, persisted: false };
  memoryMarkers.set(value.sessionId, memoryEntry);

  const existingFlight = claimFlights(promptStorage).get(value.sessionId);
  if (
    existingFlight &&
    authorityMatches(existingFlight.pending, value) &&
    existingFlight.pending.attemptId !== value.attemptId
  ) {
    existingFlight.cancelled = true;
    existingFlight.finalized = true;
    claimFlights(promptStorage).delete(value.sessionId);
  }

  // Clear stale durable presentation best-effort. These operations are kept
  // independent so one failing storage method cannot prevent the others.
  try {
    const existingPending = readPendingMarketplaceOAuthPrompt(value.sessionId, promptStorage);
    if (
      existingPending &&
      authorityMatches(existingPending, value) &&
      existingPending.attemptId !== value.attemptId
    ) {
      promptStorage.removeItem(key(value.sessionId));
    }
  } catch {
    // memoryEntry remains authoritative
  }
  try {
    const suggestion = readMarketplacePromptSuggestion(value.sessionId, promptStorage);
    if (
      suggestion &&
      authorityMatches(suggestion, value) &&
      suggestion.attemptId !== value.attemptId
    ) {
      promptStorage.removeItem(suggestionKey(value.sessionId));
    }
  } catch {
    // memoryEntry remains authoritative
  }
  try {
    promptStorage.setItem(attemptKey(value.sessionId), JSON.stringify(marker));
    // Do not let a re-entrant/newer marker write downgrade its memory fence.
    if (memoryMarkers.get(value.sessionId) === memoryEntry) memoryEntry.persisted = true;
  } catch {
    // Invalidate a readable older marker/suggestion where removal is still
    // allowed (for example quota failure). The memory marker remains the
    // authority even when a read-only storage implementation rejects these.
    try {
      promptStorage.removeItem(attemptKey(value.sessionId));
    } catch {
      // memoryEntry remains authoritative
    }
    try {
      promptStorage.removeItem(suggestionKey(value.sessionId));
    } catch {
      // memoryEntry remains authoritative
    }
  }
}

/** Fence presentation state when any newer OAuth attempt starts in this tab. */
export function markMarketplacePromptAttempt(
  value: MarketplacePromptAttemptMarker,
  storage?: PromptStorage
): void {
  let promptStorage: PromptStorage | undefined;
  try {
    promptStorage = tabStorage(storage);
    installMarketplacePromptAttempt(value, promptStorage);
  } catch {
    // OAuth remains recoverable; stale actions still revalidate fail closed
    // when the browser refuses tab-local storage.
  } finally {
    if (promptStorage) notifyPromptStateChanged(promptStorage);
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
  pending: MarketplaceOAuthHandoffAuthority,
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
  if (existing && !existing.finalized && !existing.cancelled) {
    // A replacement effect for the same authority adopts the flight. A
    // different signed-in identity must neither join nor cancel it; central
    // auth lifecycle cleanup owns invalidating the departing identity.
    return authorityMatches(existing.pending, authority) ? existing : null;
  }

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
 * Every terminal outcome, including success, permanently consumes the
 * handoff. Only pending/exchanging attempts or transient reads retain it, and
 * then only while the exact session/identity authority is still current.
 */
export async function claimMarketplaceOAuthPrompt(input: {
  client: AgorClient;
  sessionId: string;
  authenticatedServerIds: ReadonlySet<string>;
  authority: MarketplaceOAuthHandoffAuthority;
  isCurrent: () => boolean;
  /** Exact session/identity authority, independent of one React effect mount. */
  isAuthorityCurrent?: () => boolean;
  storage?: PromptStorage;
}): Promise<MarketplacePromptSuggestionState | null> {
  if (!input.isCurrent()) return null;
  const isAuthorityCurrent = input.isAuthorityCurrent ?? input.isCurrent;
  if (!isAuthorityCurrent()) return null;
  let storage: PromptStorage;
  try {
    storage = tabStorage(input.storage);
  } catch {
    return null;
  }
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
    // Durable terminal authority wins over a stale React claimant. Never let
    // unmount/logout restore a failed, cancelled, pruned, malformed, or
    // wrong-server attempt.
    if (outcome.kind === 'missing') {
      finalizeClaimFlight(storage, flights, flight, false);
      return null;
    }
    if (outcome.kind === 'found') {
      const { attempt } = outcome;
      if (
        (attempt.status === 'succeeded' &&
          (attempt.mcp_server_id === undefined ||
            String(attempt.mcp_server_id) !== pending.serverId)) ||
        (attempt.status !== 'pending' &&
          attempt.status !== 'exchanging' &&
          attempt.status !== 'succeeded')
      ) {
        finalizeClaimFlight(storage, flights, flight, false);
        return null;
      }
      if (attempt.status === 'succeeded') {
        if (flight.consumed) return null;
        if (
          !input.isCurrent() ||
          !isAuthorityCurrent() ||
          !input.authenticatedServerIds.has(pending.serverId)
        ) {
          // Success is terminal and is never restored. Defer final cleanup
          // until the last claimant leaves so a simultaneously mounted,
          // current replacement effect can still stage the suggestion once.
          return null;
        }
        const suggestion = saveMarketplacePromptSuggestion(
          {
            sessionId: pending.sessionId,
            attemptId: pending.attemptId,
            prompt: pending.prompt,
            authority: input.authority,
          },
          storage
        );
        if (!suggestion) {
          finalizeClaimFlight(storage, flights, flight, false);
          return null;
        }
        flight.consumed = true;
        finalizeClaimFlight(storage, flights, flight, false);
        return suggestion;
      }
    }
    // Effect cancellation is not terminal: a replacement effect/remount with
    // the same authority joins this flight, or the last stale claimant restores
    // the exact handoff for a later remount.
    if (!isAuthorityCurrent()) {
      return null;
    }
    if (!input.isCurrent()) {
      retry = true;
      return null;
    }
    if (outcome.kind === 'transient') {
      retry = true;
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
    attemptId?: string;
    prompt: string;
    authority: MarketplaceOAuthHandoffAuthority;
  },
  storage?: PromptStorage
): MarketplacePromptSuggestionState | null {
  if (!input.prompt.trim()) return null;
  const attemptId = input.attemptId ?? `connect:${input.sessionId}`;
  const suggestion: MarketplacePromptSuggestionState = {
    sessionId: input.sessionId,
    attemptId,
    prompt: input.prompt,
    ...input.authority,
    createdAt: Date.now(),
  };
  let promptStorage: PromptStorage | undefined;
  try {
    promptStorage = tabStorage(storage);
    installMarketplacePromptAttempt(suggestion, promptStorage);
    promptStorage.setItem(suggestionKey(input.sessionId), JSON.stringify(suggestion));
  } catch {
    // Return fully authority-scoped in-memory state. The tab-memory attempt
    // fence remains authoritative even when durable suggestion storage fails.
  }
  if (promptStorage) notifyPromptStateChanged(promptStorage);
  return suggestion;
}

export function consumeMarketplacePromptSuggestion(
  sessionId: string,
  authority: MarketplaceOAuthHandoffAuthority,
  storage?: PromptStorage
): string | null {
  return consumeMarketplacePromptSuggestionState(sessionId, authority, storage)?.prompt ?? null;
}

export function consumeMarketplacePromptSuggestionState(
  sessionId: string,
  authority: MarketplaceOAuthHandoffAuthority,
  storage?: PromptStorage
): MarketplacePromptSuggestionState | null {
  try {
    const promptStorage = tabStorage(storage);
    const value = readMarketplacePromptSuggestion(sessionId, promptStorage);
    if (!value) return null;
    if (
      value.sessionId !== sessionId ||
      value.userId !== authority.userId ||
      value.role !== authority.role ||
      value.authGeneration !== authority.authGeneration ||
      typeof value.attemptId !== 'string' ||
      typeof value.prompt !== 'string' ||
      typeof value.createdAt !== 'number' ||
      Date.now() - value.createdAt > MAX_AGE_MS
    ) {
      promptStorage.removeItem(suggestionKey(sessionId));
      notifyPromptStateChanged(promptStorage);
      return null;
    }
    promptStorage.removeItem(suggestionKey(sessionId));
    notifyPromptStateChanged(promptStorage);
    if (!isMarketplacePromptSuggestionCurrent(value, promptStorage)) return null;
    return value;
  } catch {
    try {
      tabStorage(storage).removeItem(suggestionKey(sessionId));
    } catch {
      // ignore unavailable storage
    }
    return null;
  }
}

function readMarketplacePromptSuggestion(
  sessionId: string,
  storage: PromptStorage
): MarketplacePromptSuggestionState | null {
  try {
    const raw = storage.getItem(suggestionKey(sessionId));
    return raw ? (JSON.parse(raw) as MarketplacePromptSuggestionState) : null;
  } catch {
    return null;
  }
}

export function isMarketplacePromptSuggestionCurrent(
  suggestion: MarketplacePromptSuggestionState,
  storage?: PromptStorage
): boolean {
  try {
    const promptStorage = tabStorage(storage);
    const memoryMarkers = memoryAttemptMarkers(promptStorage);
    const memoryEntry = memoryMarkers.get(suggestion.sessionId);
    if (memoryEntry) {
      const current = markerMatchesSuggestion(memoryEntry.marker, suggestion);
      if (!memoryEntry.persisted) return current;

      // External sessionStorage.clear() is common during logout and test
      // isolation. A persisted memory cache cannot resurrect a marker that no
      // longer exists durably; discard it and fail closed.
      const stored = promptStorage.getItem(attemptKey(suggestion.sessionId));
      if (!stored) {
        memoryMarkers.delete(suggestion.sessionId);
        return false;
      }
      return current;
    }

    const raw = promptStorage.getItem(attemptKey(suggestion.sessionId));
    if (!raw) return false;
    const marker = JSON.parse(raw) as Partial<MarketplacePromptSuggestionState> & {
      createdAt?: number;
    };
    return markerMatchesSuggestion(marker, suggestion);
  } catch {
    return false;
  }
}

function markerMatchesSuggestion(
  marker: Partial<MarketplacePromptAttemptMarker>,
  suggestion: MarketplacePromptSuggestionState
): boolean {
  return (
    marker.sessionId === suggestion.sessionId &&
    marker.attemptId === suggestion.attemptId &&
    marker.userId === suggestion.userId &&
    marker.role === suggestion.role &&
    marker.authGeneration === suggestion.authGeneration &&
    typeof marker.createdAt === 'number' &&
    Date.now() - marker.createdAt <= MAX_AGE_MS
  );
}

export function discardMarketplacePromptSuggestion(
  sessionId: string,
  storage?: PromptStorage,
  expectedAttemptId?: string
): void {
  try {
    const promptStorage = tabStorage(storage);
    if (expectedAttemptId) {
      const current = readMarketplacePromptSuggestion(sessionId, promptStorage);
      if (current && current.attemptId !== expectedAttemptId) return;
    }
    promptStorage.removeItem(suggestionKey(sessionId));
    notifyPromptStateChanged(promptStorage);
  } catch {
    // ignore unavailable storage
  }
}

/** Fail closed when the initiating identity is removed (logout/session reset). */
export function discardMarketplaceOAuthAuthorityState(
  sessionId: string,
  storage?: PromptStorage
): void {
  let promptStorage: PromptStorage;
  try {
    promptStorage = tabStorage(storage);
  } catch {
    return;
  }
  const flight = claimFlights(promptStorage).get(sessionId);
  if (flight) {
    flight.cancelled = true;
    flight.finalized = true;
    claimFlights(promptStorage).delete(sessionId);
  }
  remove(sessionId, promptStorage);
  discardMarketplacePromptSuggestion(sessionId, promptStorage);
  try {
    memoryAttemptMarkers(promptStorage).delete(sessionId);
    promptStorage.removeItem(attemptKey(sessionId));
    notifyPromptStateChanged(promptStorage);
  } catch {
    // ignore unavailable storage
  }
}

/** Clear only the identity being logged out, even when no SessionPanel exists. */
export function discardMarketplaceOAuthStateForAuthority(
  authority: Pick<MarketplaceOAuthHandoffAuthority, 'userId' | 'role'> &
    Partial<Pick<MarketplaceOAuthHandoffAuthority, 'authGeneration'>>,
  storage?: Storage
): void {
  let promptStorage: Storage | undefined;
  try {
    promptStorage = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
  } catch {
    return;
  }
  if (!promptStorage) return;
  const flights = claimFlights(promptStorage);
  const belongsToAuthority = (value: MarketplaceOAuthHandoffAuthority) =>
    value.userId === authority.userId &&
    value.role === authority.role &&
    (authority.authGeneration === undefined || value.authGeneration === authority.authGeneration);
  let changed = false;
  for (const [sessionId, flight] of flights) {
    if (belongsToAuthority(flight.pending)) {
      flight.cancelled = true;
      flight.finalized = true;
      flights.delete(sessionId);
      changed = true;
    }
  }
  for (const [sessionId, entry] of memoryAttemptMarkers(promptStorage)) {
    if (belongsToAuthority(entry.marker)) {
      memoryAttemptMarkers(promptStorage).delete(sessionId);
      changed = true;
    }
  }
  try {
    for (let index = promptStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = promptStorage.key(index);
      if (
        !storageKey ||
        (!storageKey.startsWith(KEY_PREFIX) &&
          !storageKey.startsWith(SUGGESTION_KEY_PREFIX) &&
          !storageKey.startsWith(ATTEMPT_KEY_PREFIX))
      )
        continue;
      try {
        const value = JSON.parse(
          promptStorage.getItem(storageKey) ?? '{}'
        ) as Partial<MarketplacePromptSuggestionState>;
        if (
          typeof value.userId !== 'string' ||
          typeof value.role !== 'string' ||
          typeof value.authGeneration !== 'number'
        ) {
          promptStorage.removeItem(storageKey);
          changed = true;
        } else if (belongsToAuthority(value as MarketplaceOAuthHandoffAuthority)) {
          promptStorage.removeItem(storageKey);
          changed = true;
        }
      } catch {
        // Unknown/corrupt Marketplace state is fail-closed.
        promptStorage.removeItem(storageKey);
        changed = true;
      }
    }
  } catch {
    // A browser storage policy failure must not prevent central logout.
  }
  if (changed) notifyPromptStateChanged(promptStorage);
}
