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

function tabStorage(storage?: PromptStorage): PromptStorage {
  return storage ?? sessionStorage;
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
    tabStorage(storage).setItem(key(value.sessionId), JSON.stringify(value));
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
  storage: PromptStorage | undefined,
  isCurrent: () => boolean
): void {
  if (!isCurrent()) return;
  // Never overwrite a newer attempt installed while this status read was in
  // flight. sessionStorage makes this synchronous within the initiating tab.
  if (readPendingMarketplaceOAuthPrompt(pending.sessionId, storage)) return;
  savePendingMarketplaceOAuthPrompt(pending, storage);
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
  const pending = readPendingMarketplaceOAuthPrompt(input.sessionId, input.storage);
  if (!pending) return null;
  // Claim synchronously before the first await. A second consumer in this tab
  // cannot observe or duplicate it. Transient/pending outcomes restore only
  // if authority is still current and no newer attempt has taken its place.
  remove(input.sessionId, input.storage);
  if (
    pending.userId !== input.authority.userId ||
    pending.role !== input.authority.role ||
    pending.authGeneration !== input.authority.authGeneration
  ) {
    return null;
  }
  if (!input.isCurrent()) return null;

  let attempt: MCPOAuthAttemptResult;
  try {
    attempt = (await input.client
      .service('mcp-servers/oauth-attempt-status')
      .get(pending.attemptId)) as MCPOAuthAttemptResult;
  } catch (cause) {
    // A pruned/unknown attempt can never become this handoff's durable
    // success. Remove it now rather than allowing unrelated authentication of
    // the same server to keep retrying it until the general TTL.
    const error = cause as { code?: number; name?: string };
    if (error.code !== 404 && error.name !== 'NotFound') {
      restorePendingMarketplaceOAuthPrompt(pending, input.storage, input.isCurrent);
    }
    return null;
  }
  if (!input.isCurrent()) return null;
  if (attempt.attempt_id !== pending.attemptId) return null;
  if (attempt.status === 'succeeded' && attempt.mcp_server_id === pending.serverId) {
    // The attempt row and the authoritative authenticated-server projection
    // can land in either event order. Keep the exact-attempt handoff until both
    // agree, but never let success on another server consume it.
    if (!input.authenticatedServerIds.has(pending.serverId)) {
      restorePendingMarketplaceOAuthPrompt(pending, input.storage, input.isCurrent);
      return null;
    }
    return pending.prompt;
  }
  if (
    (attempt.status === 'succeeded' && attempt.mcp_server_id !== pending.serverId) ||
    (attempt.status !== 'pending' && attempt.status !== 'exchanging')
  ) {
    return null;
  }
  restorePendingMarketplaceOAuthPrompt(pending, input.storage, input.isCurrent);
  return null;
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
