import type { AgorClient, Session } from '@agor-live/client';
import { useServerRead } from './useServerRead';

/** Session events that can change a branch's active sessions (an archive is a patch). */
const SESSION_EVENTS = ['created', 'patched', 'removed'] as const;

const NO_SESSIONS: Session[] = [];

/**
 * A branch's active sessions, newest first, for a surface that opens one
 * branch (the BranchModal, a BranchCard popover) — the store holds only the
 * loaded scopes' sessions. Read through `useServerRead` while `branchId` is
 * set: each opening reads afresh and only its own reply lands, and a session
 * event for that branch reads it again (debounced, bounded wait). `null`
 * (closed) reads nothing.
 */
export function useBranchSessions(
  client: AgorClient | null | undefined,
  branchId: string | null
): Session[] {
  const { data } = useServerRead(
    client,
    branchId,
    (client) =>
      client.service('sessions').findAll({
        query: { branch_id: branchId, archived: false, $sort: { created_at: -1 } },
      }) as Promise<Session[]>,
    {
      subscribe: (client, { invalidate }) => {
        const sessions = client.service('sessions');
        const onSession = (session: Session) => {
          if (session.branch_id === branchId) invalidate();
        };
        for (const event of SESSION_EVENTS) sessions.on(event, onSession);
        return () => {
          for (const event of SESSION_EVENTS) sessions.off(event, onSession);
        };
      },
    }
  );
  return data ?? NO_SESSIONS;
}
