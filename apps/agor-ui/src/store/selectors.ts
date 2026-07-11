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
import type { Board, BoardEntityObject, Branch, Link, Repo, Session } from '@agor-live/client';
import { SessionStatus } from '@agor-live/client';
import type { AgorState } from './agorStore';

export const selectSessionById = (s: AgorState) => s.sessionById;
export const selectSessionsByBranch = (s: AgorState) => s.sessionsByBranch;
export const selectRepoById = (s: AgorState) => s.repoById;
export const selectBranchById = (s: AgorState) => s.branchById;
export const selectBoardById = (s: AgorState) => s.boardById;
export const selectBoardObjectById = (s: AgorState) => s.boardObjectById;
export const selectBoardObjectsByBoardId = (s: AgorState) => s.boardObjectsByBoardId;
export const selectCommentById = (s: AgorState) => s.commentById;
export const selectCardById = (s: AgorState) => s.cardById;
export const selectCardTypeById = (s: AgorState) => s.cardTypeById;
export const selectUserById = (s: AgorState) => s.userById;
export const selectMcpServerById = (s: AgorState) => s.mcpServerById;
export const selectGatewayChannelById = (s: AgorState) => s.gatewayChannelById;
export const selectUserAuthenticatedMcpServerIds = (s: AgorState) =>
  s.userAuthenticatedMcpServerIds;
export const selectArtifactById = (s: AgorState) => s.artifactById;
export const selectSessionMcpServerIds = (s: AgorState) => s.sessionMcpServerIds;
export const selectFetchAndReplaceFullSessionLinks = (s: AgorState) =>
  s.fetchAndReplaceFullSessionLinks;
export const selectFetchAndReplaceFullBranchLinks = (s: AgorState) =>
  s.fetchAndReplaceFullBranchLinks;
export const selectApplyLinkMutationResult = (s: AgorState) => s.applyLinkMutationResult;

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

/**
 * Select a single branch's session array by id. Curried so a card can memoize
 * the selector per `branchId` (stable reference while the branch doesn't
 * change) — a `session:patched` for another branch leaves THIS branch's array
 * reference untouched, so the subscription stays quiet and only the affected
 * card re-renders. Mirrors the canvas's prior `sessionsByBranch.get(id)` read.
 */
export function makeSessionsForBranchSelector(
  branchId: string | null | undefined
): (s: AgorState) => Session[] | undefined {
  return (s) => (branchId ? s.sessionsByBranch.get(branchId) : undefined);
}

// Per-id entity selectors. Same currying contract as the factories above:
// memoize per id, and the subscription only fires when THAT entity's
// reference changes (patches to other entities of the same type keep the
// map entry reference-stable only for untouched ids — the maps are rebuilt
// per write, but `get(id)` returns the same object unless id was patched).
export function makeSessionSelector(
  sessionId: string | null | undefined
): (s: AgorState) => Session | undefined {
  return (s) => (sessionId ? s.sessionById.get(sessionId) : undefined);
}

export function makeBranchSelector(
  branchId: string | null | undefined
): (s: AgorState) => Branch | undefined {
  return (s) => (branchId ? s.branchById.get(branchId) : undefined);
}

export function makeBoardSelector(
  boardId: string | null | undefined
): (s: AgorState) => Board | undefined {
  return (s) => (boardId ? s.boardById.get(boardId) : undefined);
}

export function makeRepoSelector(
  repoId: string | null | undefined
): (s: AgorState) => Repo | undefined {
  return (s) => (repoId ? s.repoById.get(repoId) : undefined);
}

export function makeSessionExistsSelector(
  sessionId: string | null | undefined
): (s: AgorState) => boolean {
  return (s) => (sessionId ? s.sessionById.has(sessionId) : false);
}

export function makeSessionMcpServerIdsSelector(
  sessionId: string | null | undefined
): (s: AgorState) => string[] | undefined {
  return (s) => (sessionId ? s.sessionMcpServerIds.get(sessionId) : undefined);
}

// Primitive board-list facts for the shell's board-fallback effect: boards
// change rarely, and subscribing to these scalars (instead of the whole map)
// keeps high-churn entity patches from waking the subscriber.
export const selectBoardCount = (s: AgorState) => s.boardById.size;
export const selectFirstBoardId = (s: AgorState): string | undefined =>
  s.boardById.keys().next().value;

const EMPTY_BRANCHES: Branch[] = Object.freeze([] as Branch[]) as Branch[];

/**
 * The branches placed on one board, in board-object order. Returns a fresh
 * array per run, so subscribe with `useStoreWithEqualityFn(..., shallow)` —
 * the consumer then re-renders only when membership or a member branch's
 * identity changes, not on unrelated branch/board-object patches.
 */
export function makeBranchesForBoardSelector(
  boardId: string | null | undefined
): (s: AgorState) => Branch[] {
  return (s) => {
    const objects = boardId ? s.boardObjectsByBoardId.get(boardId) : undefined;
    if (!objects?.length) return EMPTY_BRANCHES;
    const branches: Branch[] = [];
    for (const bo of objects) {
      if (!bo.branch_id) continue;
      const branch = s.branchById.get(bo.branch_id);
      if (branch) branches.push(branch);
    }
    return branches;
  };
}

/**
 * Count of unresolved top-level comments on one board (the header badge).
 * Scalar result: comment patches elsewhere — or edits that don't change the
 * count — leave the subscriber untouched.
 */
export function makeUnreadCommentCountSelector(
  boardId: string | null | undefined
): (s: AgorState) => number {
  return (s) => {
    if (!boardId) return 0;
    let count = 0;
    for (const c of s.commentById.values()) {
      if (c.board_id === boardId && !c.resolved && !c.parent_comment_id) count += 1;
    }
    return count;
  };
}

/**
 * Whether any unresolved comment on the board @-mentions the user (by display
 * name or email, quoted or bare — mirrors the comment editor's mention
 * formats). Boolean result for the same quiet-subscription reason as above.
 */
export function makeCommentMentionSelector(
  boardId: string | null | undefined,
  userName: string | undefined,
  userEmail: string | undefined
): (s: AgorState) => boolean {
  return (s) => {
    if (!boardId || !userName) return false;
    for (const c of s.commentById.values()) {
      if (c.board_id !== boardId || c.resolved) continue;
      if (c.content.includes(`@${userName}`) || c.content.includes(`@"${userName}"`)) return true;
      if (
        userEmail &&
        (c.content.includes(`@${userEmail}`) || c.content.includes(`@"${userEmail}"`))
      )
        return true;
    }
    return false;
  };
}

const NO_BOARD_ACTIVITY = Object.freeze({ hasRunning: false, hasReady: false });

/**
 * Session-activity flags for one board's favicon dots. Object result — pair
 * with `shallow` so only flag flips (not every session patch on the board)
 * reach the subscriber.
 */
export function makeBoardSessionActivitySelector(
  boardId: string | null | undefined
): (s: AgorState) => { hasRunning: boolean; hasReady: boolean } {
  return (s) => {
    if (!boardId) return NO_BOARD_ACTIVITY;
    let hasRunning = false;
    let hasReady = false;
    const objects = s.boardObjectsByBoardId.get(boardId);
    if (!objects) return NO_BOARD_ACTIVITY;
    for (const bo of objects) {
      if (!bo.branch_id) continue;
      const sessions = s.sessionsByBranch.get(bo.branch_id);
      if (!sessions) continue;
      for (const session of sessions) {
        if (session.archived) continue;
        if (session.status === SessionStatus.RUNNING) hasRunning = true;
        if (session.ready_for_prompt) hasReady = true;
        if (hasRunning && hasReady) return { hasRunning, hasReady };
      }
    }
    if (!hasRunning && !hasReady) return NO_BOARD_ACTIVITY;
    return { hasRunning, hasReady };
  };
}

export function makeLinksForBranchSelector(branchId: string): (s: AgorState) => Link[] | undefined {
  return (s) => s.linksByBranch.get(branchId);
}

export function makeLinksForSessionSelector(
  sessionId: string
): (s: AgorState) => Link[] | undefined {
  return (s) => s.linksBySession.get(sessionId);
}
