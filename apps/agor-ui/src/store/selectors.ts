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
import type {
  Board,
  BoardComment,
  BoardEntityObject,
  Branch,
  Repo,
  Session,
} from '@agor-live/client';
import { getTeammateConfig, isGatewaySession, SessionStatus } from '@agor-live/client';
import { getTimeMs } from '../utils/entityTime';
import { isSessionFailed } from '../utils/sessionStatus';
import { getSessionDisplayTitle } from '../utils/sessionTitle';
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
      if (
        c.board_id === boardId &&
        !c.resolved &&
        commentMentionsUser(c.content, userName, userEmail)
      )
        return true;
    }
    return false;
  };
}

/** Whether comment text @-mentions the user by display name or email, bare or quoted. */
export function commentMentionsUser(content: string, userName?: string, userEmail?: string) {
  return [userName, userEmail].some(
    (handle) => handle && (content.includes(`@${handle}`) || content.includes(`@"${handle}"`))
  );
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

/** Started by the person, not by a schedule or by another agent session. */
export const isSessionStartedByUser = (session: Session): boolean =>
  !session.scheduled_from_branch &&
  !session.genealogy?.parent_session_id &&
  !session.remote_relationships?.as_target?.length;

/** A finished run the person started and hasn't opened yet. */
export const isUnreadResult = (session: Session): boolean =>
  !!session.ready_for_prompt && isSessionStartedByUser(session) && !isGatewaySession(session);

const HOME_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface HomeSessionNeed {
  key: string;
  reason: 'permission' | 'failed' | 'finished';
  at: number;
  session: Session;
  /** Older finished runs on the same branch, newest first; the row stands for all of them. */
  earlier?: Session[];
}

export interface HomeCommentNeed {
  key: string;
  reason: 'mention' | 'reply' | 'comment';
  at: number;
  boardId: string;
  thread: BoardComment;
  comment: BoardComment;
  threadSize: number;
}

export type HomeNeed = HomeSessionNeed | HomeCommentNeed;

interface HomeBuckets {
  /** Session needs only; comments come from `makeCommentsForYouSelector`. */
  needs: HomeSessionNeed[];
  needsCount: number;
  /** `needsCount` per reason, so Home can say what a collapsed list hides. */
  needsByReason: Readonly<Record<HomeSessionNeed['reason'], number>>;
  recent: Session[];
  /** Everything `recent` would list without the cap. */
  recentCount: number;
  running: Session[];
  runningCount: number;
  /** Finished-unopened runs, counted singly (Needs you groups them per branch). */
  unreadCount: number;
  /** Boards of the caller's latest sessions, most recent first. */
  boardIds: string[];
  hasSessions: boolean;
}

export interface HomeBucketsOptions {
  userId?: string;
  now: number;
  needsLimit: number;
  recentLimit: number;
  boardsLimit?: number;
  query?: string;
  onlyStartedByMe?: boolean;
  /** Failed sessions the user already opened (id → epoch ms when opened). */
  openedFailures?: Readonly<Record<string, number>>;
}

const NEED_RANK: Record<HomeNeed['reason'], number> = {
  permission: 0,
  mention: 1,
  reply: 1,
  comment: 1,
  failed: 2,
  finished: 3,
};

/** Needs you order: permission, comments, failures, finished; newest first within each. */
export const compareHomeNeeds = (a: HomeNeed, b: HomeNeed) =>
  NEED_RANK[a.reason] - NEED_RANK[b.reason] || b.at - a.at;
const needBefore = (a: HomeNeed, b: HomeNeed) => compareHomeNeeds(a, b) < 0;
const updatedAt = (session: Session) => getTimeMs(session, 'last_updated');
const updatedBefore = (a: Session, b: Session) => updatedAt(a) > updatedAt(b);
const isFailure = (session: Session) =>
  isSessionFailed(session) || session.status === SessionStatus.TIMED_OUT;
/** Finished cleanly: completed, awaiting the next prompt, or idle after running a task. */
const succeeded = (session: Session) =>
  session.status === SessionStatus.COMPLETED ||
  (session.status === SessionStatus.IDLE &&
    (session.ready_for_prompt || session.tasks?.length > 0));

/** Insert into a list kept sorted by `before` and capped at `k`. */
function insertTopK<T>(list: T[], item: T, k: number, before: (a: T, b: T) => boolean) {
  if (k <= 0 || (list.length === k && !before(item, list[k - 1]))) return;
  let i = Math.min(list.length, k - 1);
  while (i > 0 && before(item, list[i - 1])) {
    list[i] = list[i - 1];
    i--;
  }
  list[i] = item;
}

const sameItems = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, i) => Object.is(item, b[i]));

function matchesQuery(session: Session, query: string, s: AgorState): boolean {
  const branch = s.branchById.get(session.branch_id);
  const boardId = session.branch_board_id ?? branch?.board_id;
  return [
    session.title,
    session.description,
    branch?.name,
    branch && getTeammateConfig(branch)?.displayName,
    boardId && s.boardById.get(boardId)?.name,
  ].some((text) => text?.toLowerCase().includes(query));
}

/** The same person's newer run on the branch succeeded, so the failure no longer needs them. */
function supersededFailure(session: Session, s: AgorState) {
  const failedAt = updatedAt(session);
  return (s.sessionsByBranch.get(session.branch_id) ?? []).some(
    (other) =>
      !other.archived &&
      other.created_by === session.created_by &&
      succeeded(other) &&
      updatedAt(other) > failedAt
  );
}

/**
 * Home's session needs and My work in one pass over the caller's sessions.
 * Returns capped preview slices plus counts; slices keep their identity while
 * their members do, so subscribe with `shallow` and a patch to anything
 * outside the previews re-renders nothing.
 */
export function makeHomeBucketsSelector(
  options: HomeBucketsOptions
): (s: AgorState) => HomeBuckets {
  const {
    userId,
    now,
    needsLimit,
    recentLimit,
    boardsLimit = 0,
    onlyStartedByMe,
    openedFailures = {},
  } = options;
  const query = options.query?.trim().toLowerCase() ?? '';
  const itemCache = new Map<string, HomeSessionNeed>();
  let prev: HomeBuckets | null = null;

  const sessionNeed = (
    session: Session,
    reason: HomeSessionNeed['reason'],
    earlier?: Session[]
  ) => {
    const cached = itemCache.get(session.session_id);
    if (
      cached?.session === session &&
      cached.reason === reason &&
      sameItems(cached.earlier ?? [], earlier ?? [])
    )
      return cached;
    const item = {
      key: `session:${session.session_id}`,
      reason,
      at: updatedAt(session),
      session,
      earlier,
    };
    itemCache.set(session.session_id, item);
    return item;
  };

  return (s) => {
    const needs: HomeSessionNeed[] = [];
    const recent: Session[] = [];
    const running: Session[] = [];
    let needsCount = 0;
    const needsByReason = { permission: 0, failed: 0, finished: 0 };
    let runningCount = 0;
    let unreadCount = 0;
    let recentCount = 0;
    let hasSessions = false;
    const boardAt = new Map<string, number>();
    const passes = (session: Session) =>
      (!onlyStartedByMe || isSessionStartedByUser(session)) &&
      (!query || matchesQuery(session, query, s));
    const addRecent = (session: Session) => {
      if (!passes(session)) return;
      recentCount++;
      insertTopK(recent, session, recentLimit, updatedBefore);
    };
    const addNeed = (session: Session, reason: HomeSessionNeed['reason'], earlier?: Session[]) => {
      needsCount++;
      needsByReason[reason]++;
      insertTopK(needs, sessionNeed(session, reason, earlier), needsLimit, needBefore);
    };

    const failedByBranch = new Map<string, Session>();
    const finishedByBranch = new Map<string, Session[]>();
    for (const session of userId ? s.sessionById.values() : []) {
      if (session.archived || session.created_by !== userId) continue;
      hasSessions = true;
      const boardId = session.branch_board_id ?? s.branchById.get(session.branch_id)?.board_id;
      if (boardsLimit && boardId && updatedAt(session) > (boardAt.get(boardId) ?? 0))
        boardAt.set(boardId, updatedAt(session));
      if (session.status === SessionStatus.RUNNING) {
        runningCount++;
        if (passes(session)) insertTopK(running, session, recentLimit, updatedBefore);
      }
      if (session.status === SessionStatus.AWAITING_PERMISSION) {
        addNeed(session, 'permission');
      } else if (
        isFailure(session) &&
        updatedAt(session) >= now - HOME_FAILED_WINDOW_MS &&
        updatedAt(session) > (openedFailures[session.session_id] ?? 0) &&
        !supersededFailure(session, s)
      ) {
        const shown = failedByBranch.get(session.branch_id);
        if (shown && !updatedBefore(session, shown)) {
          addRecent(session);
        } else {
          failedByBranch.set(session.branch_id, session);
          if (shown) addRecent(shown);
        }
      } else if (isUnreadResult(session)) {
        unreadCount++;
        const finished = finishedByBranch.get(session.branch_id);
        if (finished) finished.push(session);
        else finishedByBranch.set(session.branch_id, [session]);
      } else {
        addRecent(session);
      }
    }
    for (const session of failedByBranch.values()) addNeed(session, 'failed');
    for (const finished of finishedByBranch.values()) {
      const [latest, ...earlier] = finished.sort((a, b) => updatedAt(b) - updatedAt(a));
      addNeed(latest, 'finished', earlier.length ? earlier : undefined);
    }
    const boardIds = [...boardAt]
      .sort((a, b) => b[1] - a[1])
      .slice(0, boardsLimit)
      .map(([id]) => id);

    const next: HomeBuckets = {
      needs: prev && sameItems(prev.needs, needs) ? prev.needs : needs,
      needsCount,
      needsByReason:
        prev &&
        (Object.keys(needsByReason) as HomeSessionNeed['reason'][]).every(
          (k) => prev?.needsByReason[k] === needsByReason[k]
        )
          ? prev.needsByReason
          : needsByReason,
      recent: prev && sameItems(prev.recent, recent) ? prev.recent : recent,
      recentCount,
      running: prev && sameItems(prev.running, running) ? prev.running : running,
      runningCount,
      unreadCount,
      boardIds: prev && sameItems(prev.boardIds, boardIds) ? prev.boardIds : boardIds,
      hasSessions,
    };
    if (prev && (Object.keys(next) as (keyof HomeBuckets)[]).every((k) => prev?.[k] === next[k]))
      return prev;
    prev = next;
    return next;
  };
}

/**
 * Unresolved threads that need the caller: @mentions, replies after they
 * posted, and new comments on their sessions or branches. One row per thread,
 * newest first; a thread leaves once the caller replied last. Recomputed only
 * when comments, branches or session hydration change, never per session patch.
 */
export function makeCommentsForYouSelector({
  userId,
  userName,
  userEmail,
}: {
  userId?: string;
  userName?: string;
  userEmail?: string;
}): (s: AgorState) => HomeCommentNeed[] {
  let source: unknown[] = [];
  let result: HomeCommentNeed[] = [];
  let byKey = new Map<string, HomeCommentNeed>();
  return (s) => {
    const inputs = [s.commentById, s.branchById, s.sessionsHydrated];
    if (inputs.every((input, i) => input === source[i])) return result;
    source = inputs;
    const next: HomeCommentNeed[] = [];
    if (!userId) {
      result = next;
      return result;
    }

    const threads = new Map<string, BoardComment[]>();
    for (const c of s.commentById.values()) {
      const rootId = c.parent_comment_id ?? c.comment_id;
      const thread = threads.get(rootId);
      if (thread) thread.push(c);
      else threads.set(rootId, [c]);
    }
    for (const [rootId, comments] of threads) {
      const root = s.commentById.get(rootId);
      if (!root || root.resolved) continue;
      let last = root;
      let lastOther: BoardComment | undefined;
      let participated = false;
      let mentioned = false;
      for (const c of comments) {
        if (getTimeMs(c, 'created_at') >= getTimeMs(last, 'created_at')) last = c;
        if (c.created_by === userId) {
          participated = true;
          continue;
        }
        if (!lastOther || getTimeMs(c, 'created_at') >= getTimeMs(lastOther, 'created_at'))
          lastOther = c;
        mentioned ||=
          !!c.mentions?.includes(userId as BoardComment['created_by']) ||
          commentMentionsUser(c.content, userName, userEmail);
      }
      if (!lastOther || last.created_by === userId) continue;
      const branch = root.branch_id ? s.branchById.get(root.branch_id) : undefined;
      const onMine =
        (root.session_id && s.sessionById.get(root.session_id)?.created_by === userId) ||
        (branch && (branch.primary_owner_user_id ?? branch.created_by) === userId);
      const reason = mentioned ? 'mention' : participated ? 'reply' : onMine ? 'comment' : null;
      if (!reason) continue;
      const key = `comment:${rootId}`;
      const prev = byKey.get(key);
      next.push(
        prev?.thread === root &&
          prev.comment === lastOther &&
          prev.reason === reason &&
          prev.threadSize === comments.length
          ? prev
          : {
              key,
              reason,
              at: getTimeMs(lastOther, 'created_at'),
              boardId: root.board_id,
              thread: root,
              comment: lastOther,
              threadSize: comments.length,
            }
      );
    }
    next.sort((a, b) => b.at - a.at);
    byKey = new Map(next.map((item) => [item.key, item]));
    if (!sameItems(result, next)) result = next;
    return result;
  };
}

/** The caller's most recently updated session on one branch (Home's "Continue …" link). */
export function makeLatestOwnSessionSelector(
  branchId: string | undefined,
  userId: string | undefined
): (s: AgorState) => { sessionId: string; title: string } | undefined {
  return (s) => {
    let latest: Session | undefined;
    for (const session of (branchId && s.sessionsByBranch.get(branchId)) || []) {
      if (session.archived || session.created_by !== userId) continue;
      if (!latest || updatedBefore(session, latest)) latest = session;
    }
    return latest
      ? {
          sessionId: latest.session_id,
          title: getSessionDisplayTitle(latest, { includeAgentFallback: true }),
        }
      : undefined;
  };
}

/**
 * The caller's own teammates, or teammates someone else owns whose home board
 * the server returned to the caller. Board lists are scoped by the live board
 * policy, so a board in the store is one the caller can see; superadmins
 * bypass that scoping and must be checked against the policy separately.
 */
export function makeTeammatesSelector(
  userId: string | undefined,
  whose: 'own' | 'shared'
): (s: AgorState) => Branch[] {
  let source: [AgorState['branchById'], AgorState['boardById']] | null = null;
  let result: Branch[] = [];
  return (s) => {
    if (source?.[0] === s.branchById && source[1] === s.boardById) return result;
    source = [s.branchById, s.boardById];
    result = [];
    for (const branch of userId ? s.branchById.values() : []) {
      if (branch.archived || !getTeammateConfig(branch)) continue;
      const own = (branch.primary_owner_user_id ?? branch.created_by) === userId;
      const board = branch.board_id ? s.boardById.get(branch.board_id) : undefined;
      if (whose === 'own' ? !own : own || !board || board.archived) continue;
      result.push(branch);
    }
    const name = (b: Branch) => getTeammateConfig(b)?.displayName ?? b.name;
    result.sort((a, b) => name(a).localeCompare(name(b)));
    return result;
  };
}
