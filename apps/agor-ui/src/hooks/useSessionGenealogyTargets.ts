import type { AgorClient, Session } from '@agor-live/client';
import { useEnsureSessions } from './useEnsureRows';

/** The sessions `session` links to: parent, fork source, callback and remote-create ends, children. */
function genealogyTargetIds(session: Session | null | undefined): string[] {
  if (!session) return [];
  const ids = new Set<string>([
    ...(session.genealogy?.children ?? []),
    session.genealogy?.parent_session_id ?? '',
    session.genealogy?.forked_from_session_id ?? '',
    session.callback_config?.callback_session_id ?? '',
  ]);
  for (const relationship of session.remote_relationships?.as_target ?? []) {
    ids.add(relationship.source_session_id);
    ids.add(relationship.callback_session_id ?? '');
  }
  for (const relationship of session.remote_relationships?.as_source ?? []) {
    ids.add(relationship.target_session_id);
  }
  ids.delete('');
  ids.delete(session.session_id);
  return [...ids];
}

/**
 * Resolve an opened session's genealogy links without global data: the
 * linked sessions the store lacks are read by id (`useEnsureSessions`).
 * Re-reads only when the set of linked ids changes, never on a patch of the
 * session itself.
 */
export function useSessionGenealogyTargets(
  client: AgorClient | null | undefined,
  session: Session | null | undefined
): void {
  useEnsureSessions(client, genealogyTargetIds(session));
}
