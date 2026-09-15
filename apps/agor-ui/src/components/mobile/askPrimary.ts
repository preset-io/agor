import type { Session } from '@agor-live/client';

/** Most-recently-updated non-archived session for a branch, if any. */
export function latestSession(sessions: Session[]): Session | undefined {
  return sessions
    .filter((s) => !s.archived)
    .sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''))[0];
}

export type AskPrimaryTarget =
  | { kind: 'continue'; sessionId: string }
  | { kind: 'create'; branchId: string; boardId: string }
  | { kind: 'pick' };

/**
 * Decide what the center "Ask primary assistant" action should do:
 * continue the live primary session, start a fresh one, or (no primary) prompt
 * the caller to pick/create one. Pure so the headline flow is unit-testable.
 */
export function resolveAskPrimaryTarget(
  branch: { branch_id: string; board_id?: string | null } | null | undefined,
  sessionsForBranch: Session[]
): AskPrimaryTarget {
  if (!branch) return { kind: 'pick' };
  const live = latestSession(sessionsForBranch);
  if (live) return { kind: 'continue', sessionId: live.session_id };
  return { kind: 'create', branchId: branch.branch_id, boardId: branch.board_id ?? '' };
}
