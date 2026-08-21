import type { MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';

const KEY_PREFIX = 'agor-marketplace-oauth-prompt:';
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

function remove(sessionId: string): void {
  try {
    localStorage.removeItem(key(sessionId));
  } catch {
    // ignore unavailable storage
  }
}

/** Remove only the handoff created by this exact popup/attempt operation. */
export function discardPendingMarketplaceOAuthPrompt(
  sessionId: string,
  attemptId: string,
  popupOperationId: string
): void {
  const pending = readPendingMarketplaceOAuthPrompt(sessionId);
  if (pending?.attemptId === attemptId && pending.popupOperationId === popupOperationId) {
    remove(sessionId);
  }
}

/** Nonsecret handoff only; OAuth protocol data and credentials never enter it. */
export function savePendingMarketplaceOAuthPrompt(value: PendingMarketplaceOAuthPrompt): void {
  try {
    localStorage.setItem(key(value.sessionId), JSON.stringify(value));
  } catch {
    // OAuth still succeeds; only prompt seeding is skipped.
  }
}

export function readPendingMarketplaceOAuthPrompt(
  sessionId: string
): PendingMarketplaceOAuthPrompt | null {
  try {
    const raw = localStorage.getItem(key(sessionId));
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
      remove(sessionId);
      return null;
    }
    return value as PendingMarketplaceOAuthPrompt;
  } catch {
    remove(sessionId);
    return null;
  }
}

/** Attempt-scoped compare-and-delete prevents one flow consuming another. */
export function consumePendingMarketplaceOAuthPrompt(
  sessionId: string,
  attemptId: string
): PendingMarketplaceOAuthPrompt | null {
  const value = readPendingMarketplaceOAuthPrompt(sessionId);
  if (!value || value.attemptId !== attemptId) return null;
  remove(sessionId);
  return value;
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
}): Promise<string | null> {
  const pending = readPendingMarketplaceOAuthPrompt(input.sessionId);
  if (!pending) return null;
  if (
    pending.userId !== input.authority.userId ||
    pending.role !== input.authority.role ||
    pending.authGeneration !== input.authority.authGeneration
  ) {
    remove(input.sessionId);
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
    if (error.code === 404 || error.name === 'NotFound') remove(input.sessionId);
    return null;
  }
  if (!input.isCurrent()) return null;
  if (attempt.status === 'succeeded' && attempt.mcp_server_id === pending.serverId) {
    // The attempt row and the authoritative authenticated-server projection
    // can land in either event order. Keep the exact-attempt handoff until both
    // agree, but never let success on another server consume it.
    if (!input.authenticatedServerIds.has(pending.serverId)) return null;
    return consumePendingMarketplaceOAuthPrompt(input.sessionId, pending.attemptId)?.prompt ?? null;
  }
  if (
    (attempt.status === 'succeeded' && attempt.mcp_server_id !== pending.serverId) ||
    (attempt.status !== 'pending' && attempt.status !== 'exchanging')
  ) {
    remove(input.sessionId);
  }
  return null;
}
