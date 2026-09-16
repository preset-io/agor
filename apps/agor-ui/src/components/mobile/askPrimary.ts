export type AskPrimaryTarget =
  | { kind: 'create'; branchId: string; boardId: string }
  | { kind: 'pick' };

/**
 * Decide what the center "Ask primary assistant" action should do: always start
 * a FRESH session on the primary teammate's branch, or (no primary) prompt the
 * caller to pick/create one. Every tap opens a new session; it never continues
 * an existing one. Pure so the headline flow is unit-testable.
 */
export function resolveAskPrimaryTarget(
  branch: { branch_id: string; board_id?: string | null } | null | undefined
): AskPrimaryTarget {
  if (!branch) return { kind: 'pick' };
  return { kind: 'create', branchId: branch.branch_id, boardId: branch.board_id ?? '' };
}
