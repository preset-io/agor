import type { Board, Branch, Session } from '@agor-live/client';

/** Resolve only the current session's accessible board, never a previously viewed board. */
export function sessionBoardId(
  session: Session | undefined,
  branches: Map<string, Branch>,
  boards: Map<string, Board>
): string | undefined {
  if (!session) return undefined;
  const branch = branches.get(session.branch_id);
  // A live branch is authoritative (including a move off a board). The joined
  // projection lets cold/archived session links close before branch hydration.
  const id = branch ? branch.board_id : session.branch_board_id;
  return id && boards.has(id) ? id : undefined;
}
