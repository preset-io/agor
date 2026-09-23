import type { Session, SessionStatus } from '@agor-live/client';
import { agorStore, shallow, useStoreWithEqualityFn } from '../../store/agorStore';

const AWAITING_STATUSES = new Set<SessionStatus>(['awaiting_permission', 'awaiting_input']);

/**
 * The current user's unarchived sessions waiting on a reply or permission.
 * Shared by the desktop "Needs you" block and the mobile "Jump back in" list.
 */
export function useAwaitingSessions(currentUserId?: string): Session[] {
  // Shallow equality on the derived array: session patches that don't change
  // the awaiting set (element identities) leave the caller un-rendered.
  return useStoreWithEqualityFn(
    agorStore,
    (state) => {
      const waiting: Session[] = [];
      for (const session of state.sessionById.values()) {
        if (
          !session.archived &&
          AWAITING_STATUSES.has(session.status) &&
          (!currentUserId || session.created_by === currentUserId)
        ) {
          waiting.push(session);
        }
      }
      return waiting;
    },
    shallow
  );
}
