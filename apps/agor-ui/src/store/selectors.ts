/**
 * Narrow store selectors for entity-map consumers.
 *
 * Each whole-map selector is a module-level function so a subscribing component
 * passes the SAME selector reference on every render (no per-render closure
 * allocation on hot paths). Because the store preserves slice references on
 * idempotent writes (`Object.is` short-circuit), `useAgorStore(selectX)` only
 * re-renders its consumer when that specific slice's reference changes.
 *
 * Board-scoped data uses a curried factory so a consumer subscribes to exactly
 * one board's bucket: a patch to another board's objects leaves this board's
 * array reference untouched, so the subscription doesn't fire.
 */
import type { BoardEntityObject } from '@agor-live/client';
import type { AgorState } from './agorStore';

export const selectSessionsByBranch = (s: AgorState) => s.sessionsByBranch;
export const selectRepoById = (s: AgorState) => s.repoById;
export const selectBranchById = (s: AgorState) => s.branchById;
export const selectCommentById = (s: AgorState) => s.commentById;
export const selectCardById = (s: AgorState) => s.cardById;
export const selectUserById = (s: AgorState) => s.userById;
export const selectMcpServerById = (s: AgorState) => s.mcpServerById;
export const selectUserAuthenticatedMcpServerIds = (s: AgorState) =>
  s.userAuthenticatedMcpServerIds;

/**
 * Select a single board's board-object array. Curried so callers can memoize
 * the selector per `boardId` (stable reference while the board doesn't change)
 * — the returned bucket is reference-stable across unrelated patches, so the
 * subscription stays quiet unless THIS board's objects change.
 */
export function makeBoardObjectsForBoardSelector(
  boardId: string | undefined
): (s: AgorState) => BoardEntityObject[] | undefined {
  return (s) => (boardId ? s.boardObjectsByBoardId.get(boardId) : undefined);
}
