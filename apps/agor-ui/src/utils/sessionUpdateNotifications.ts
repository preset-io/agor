import type { Session, SessionID } from '@agor-live/client';
import type { AuthorityOperation } from '../hooks/useAuthorityOperationGuard';

export type LatestSessionUpdateRequests = Map<SessionID, symbol>;

interface RunSessionUpdateWithLatestNotificationOptions {
  sessionId: SessionID;
  updates: Partial<Session>;
  latestRequests: LatestSessionUpdateRequests;
  authority: Pick<AuthorityOperation, 'isCurrent'>;
  updateSession: (sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

/**
 * Persist a session update while keeping completion feedback latest-only.
 *
 * Requests for different sessions are independent. If requests for one session
 * overlap, only the newest request may notify; an authority change or unmount
 * suppresses every completion from the obsolete UI lifetime.
 */
export async function runSessionUpdateWithLatestNotification({
  sessionId,
  updates,
  latestRequests,
  authority,
  updateSession,
  showSuccess,
  showError,
}: RunSessionUpdateWithLatestNotificationOptions): Promise<void> {
  if (!authority.isCurrent()) return;

  const request = Symbol(sessionId);
  latestRequests.set(sessionId, request);
  const session = await updateSession(sessionId, updates);

  if (!authority.isCurrent() || latestRequests.get(sessionId) !== request) return;
  latestRequests.delete(sessionId);

  if (session) showSuccess('Session updated successfully!');
  else showError('Failed to update session');
}
