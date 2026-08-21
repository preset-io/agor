const KEY_PREFIX = 'agor-marketplace-oauth-prompt:';
const MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingMarketplaceOAuthPrompt {
  sessionId: string;
  serverId: string;
  attemptId: string;
  prompt: string;
  createdAt: number;
}

const key = (sessionId: string) => `${KEY_PREFIX}${sessionId}`;

/** Nonsecret handoff only; OAuth protocol data and credentials never enter it. */
export function savePendingMarketplaceOAuthPrompt(value: PendingMarketplaceOAuthPrompt): void {
  try {
    localStorage.setItem(key(value.sessionId), JSON.stringify(value));
  } catch {
    // localStorage unavailable/full: OAuth still succeeds; only prompt seeding is skipped.
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
      typeof value.prompt !== 'string' ||
      typeof value.createdAt !== 'number' ||
      Date.now() - value.createdAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(key(sessionId));
      return null;
    }
    return value as PendingMarketplaceOAuthPrompt;
  } catch {
    return null;
  }
}

/** Deleting before insertion makes the handoff exactly-once even across rerenders. */
export function consumePendingMarketplaceOAuthPrompt(
  sessionId: string
): PendingMarketplaceOAuthPrompt | null {
  const value = readPendingMarketplaceOAuthPrompt(sessionId);
  try {
    localStorage.removeItem(key(sessionId));
  } catch {
    // ignore
  }
  return value;
}

/**
 * Durable-auth gate used by SessionPanel. Authentication absence retains the
 * handoff; once authenticated it is consumed exactly once, and existing user
 * text wins over the staged prompt.
 */
export function takeMarketplaceOAuthPrompt(
  sessionId: string,
  authenticatedServerIds: ReadonlySet<string>,
  currentComposerValue: string
): string | null {
  const pending = readPendingMarketplaceOAuthPrompt(sessionId);
  if (!pending || !authenticatedServerIds.has(pending.serverId)) return null;
  const consumed = consumePendingMarketplaceOAuthPrompt(sessionId);
  if (!consumed || currentComposerValue.trim()) return null;
  return consumed.prompt;
}
