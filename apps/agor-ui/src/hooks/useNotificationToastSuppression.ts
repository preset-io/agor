/**
 * useNotificationToastSuppression — codified rule for toast-vs-notification
 * double-signal avoidance per design doc §3.6.
 *
 * When a `notification:created` event arrives and the user is *already* on
 * the source page (board or session detail), any toast triggered by that
 * notification is suppressed — the notification is the durable record, the
 * toast would just be noise. The bell badge still updates.
 *
 * Producers and helpers that want to emit a toast in response to a
 * notification should call `shouldSuppressToast(notification)` first.
 *
 * This hook reads the current board / session from props (caller supplies
 * the current route), so the rule stays a pure predicate.
 */

import type { Notification } from '@agor-live/client';
import { useCallback } from 'react';

export interface UseNotificationToastSuppressionArgs {
  /** The board the user is currently viewing, or undefined. */
  currentBoardId?: string | null;
  /** The session detail panel the user is currently looking at, or undefined. */
  currentSessionId?: string | null;
}

export interface NotificationToastSuppression {
  /** Returns true if a toast triggered by this notification should be suppressed. */
  shouldSuppressToast: (notification: Notification) => boolean;
}

export function useNotificationToastSuppression(
  args: UseNotificationToastSuppressionArgs
): NotificationToastSuppression {
  const { currentBoardId, currentSessionId } = args;

  const shouldSuppressToast = useCallback(
    (notification: Notification) => {
      // Source-session match: the user is looking at the detail panel that
      // the notification points at.
      if (
        notification.source_session_id &&
        currentSessionId &&
        notification.source_session_id === currentSessionId
      ) {
        return true;
      }
      // Source-board match without a more-specific session — viewing the
      // board where the event happened.
      if (
        notification.source_board_id &&
        currentBoardId &&
        notification.source_board_id === currentBoardId &&
        !notification.source_session_id
      ) {
        return true;
      }
      return false;
    },
    [currentBoardId, currentSessionId]
  );

  return { shouldSuppressToast };
}
