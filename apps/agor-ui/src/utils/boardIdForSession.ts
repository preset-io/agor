/**
 * The board a session belongs to. A loaded branch is authoritative (it tracks
 * moves between boards live); otherwise fall back to the `branch_board_id` the
 * daemon joins onto every session row, so a session resolves to its board
 * before its branch is loaded (Home first paint, cold deep links).
 */
export function boardIdForSession(
  session: { branch_id?: string; branch_board_id?: string | null } | undefined,
  branchById: ReadonlyMap<string, { board_id?: string | null }>
): string | undefined {
  if (!session) return undefined;
  const branch = session.branch_id ? branchById.get(session.branch_id) : undefined;
  const boardId = branch ? branch.board_id : session.branch_board_id;
  return boardId ?? undefined;
}
