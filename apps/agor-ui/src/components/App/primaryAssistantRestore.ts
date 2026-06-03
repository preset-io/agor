export interface PrimaryAssistantRestoreInput {
  currentBoardId: string | null | undefined;
  primaryAssistantBranchId: string | null | undefined;
  effectiveSelectedSessionId: string | null | undefined;
  autoOpenedAssistantBoardId: string | null | undefined;
  hasExplicitEntityTarget: boolean;
  sessions: Array<{ session_id: string; archived: boolean; last_updated: string }>;
}

/**
 * Pick the primary assistant session that should be auto-opened for generic
 * board/app entry points.
 *
 * Explicit entity URLs (`/s/...`, `/w/...`, `/a/...`) are deliberately
 * excluded: those routes already carry the user's target and can spend an
 * initialization render with no selected session while URL→state resolution
 * catches up.
 */
export function getPrimaryAssistantSessionToRestore({
  currentBoardId,
  primaryAssistantBranchId,
  effectiveSelectedSessionId,
  autoOpenedAssistantBoardId,
  hasExplicitEntityTarget,
  sessions,
}: PrimaryAssistantRestoreInput): string | null {
  if (hasExplicitEntityTarget) return null;
  if (!currentBoardId || !primaryAssistantBranchId || effectiveSelectedSessionId) return null;
  if (autoOpenedAssistantBoardId === currentBoardId) return null;

  return (
    sessions
      .filter((session) => !session.archived)
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime())[0]
      ?.session_id ?? null
  );
}
