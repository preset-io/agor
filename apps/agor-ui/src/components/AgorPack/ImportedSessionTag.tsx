import type { AgorClient, Branch, Session } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { Tag } from '../Tag';
import { PACK_COPY } from './packCopy';

/** Read-only history from an `.agor` import. */
export function isImportedSession(session: Pick<Session, 'archived' | 'archived_reason'>): boolean {
  return session.archived === true && session.archived_reason === 'imported';
}

/** "Imported" on session rows of imported history. */
export const ImportedSessionTag: React.FC<{ session: Session }> = ({ session }) =>
  isImportedSession(session) ? (
    <Tag style={{ marginInlineEnd: 0, flex: '0 0 auto' }}>{PACK_COPY.tagImported}</Tag>
  ) : null;

/**
 * Imported history of a teammate. Archived sessions aren't in the store's
 * branch lists, so an imported teammate's panel loads them itself.
 */
export function useImportedSessions(
  client: AgorClient | null | undefined,
  branch: Branch | null | undefined
): Session[] {
  const [sessions, setSessions] = useState<Session[]>([]);
  const branchId = branch?.agor_pack?.imported_from ? branch.branch_id : null;
  useEffect(() => {
    setSessions([]);
    if (!client || !branchId) return;
    let cancelled = false;
    client
      .service('sessions')
      .find({ query: { branch_id: branchId, archived: true, $limit: 500 } })
      .then((result: Session[] | { data: Session[] }) => {
        const rows = Array.isArray(result) ? result : result.data;
        if (!cancelled) setSessions(rows.filter(isImportedSession));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, branchId]);
  return sessions;
}
