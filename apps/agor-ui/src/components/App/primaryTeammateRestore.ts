export interface PrimaryAssistantRestoreInput {
  currentBoardId: string | null | undefined;
  primaryTeammateBranchId: string | null | undefined;
  effectiveSelectedSessionId: string | null | undefined;
  autoOpenedAssistantBoardId: string | null | undefined;
  restoreAllowed: boolean;
  sessions: Array<{ session_id: string; archived: boolean; last_updated: string }>;
}

/**
 * Pick the primary teammate session that should be auto-opened for generic
 * board/app entry points.
 *
 * Callers decide when generic restore is allowed. Explicit entity URLs
 * (`/s/...`, `/w/...`, `/a/...`) and settings URLs are deliberately excluded:
 * those routes already carry the user's target and can spend an initialization
 * render before URL→state resolution catches up.
 */
export function getPrimaryTeammateSessionToRestore({
  currentBoardId,
  primaryTeammateBranchId,
  effectiveSelectedSessionId,
  autoOpenedAssistantBoardId,
  restoreAllowed,
  sessions,
}: PrimaryAssistantRestoreInput): string | null {
  if (!restoreAllowed) return null;
  if (!currentBoardId || !primaryTeammateBranchId || effectiveSelectedSessionId) return null;
  if (autoOpenedAssistantBoardId === currentBoardId) return null;

  return (
    sessions
      .filter((session) => !session.archived)
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime())[0]
      ?.session_id ?? null
  );
}
