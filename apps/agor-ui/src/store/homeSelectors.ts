/**
 * Home page selectors: session needs and My work buckets, comments that need
 * the caller, the caller's latest session on a branch, and teammate lists.
 * Each factory keeps its previous result while the inputs it reads are
 * unchanged, so Home subscribers stay quiet through unrelated store patches.
 */
import type { BoardComment, Branch, Session } from '@agor-live/client';
import { getTeammateConfig, isGatewaySession, SessionStatus } from '@agor-live/client';
import { boardIdForSession } from '../utils/boardIdForSession';
import { commentMentionsUser } from '../utils/commentMentions';
import { getTimeMs } from '../utils/entityTime';
import { isSessionFailed } from '../utils/sessionStatus';
import { getSessionDisplayTitle } from '../utils/sessionTitle';
import type { AgorState } from './agorStore';

/** Started by the person, not by a schedule or by another agent session; gateway messages count, since the person asked for them. */
export const isSessionStartedByUser = (session: Session): boolean =>
  !session.scheduled_from_branch &&
  !session.genealogy?.parent_session_id &&
  !session.remote_relationships?.as_target?.length;

const isFailure = (session: Session) =>
  isSessionFailed(session) || session.status === SessionStatus.TIMED_OUT;

/**
 * A finished run the person started and hasn't opened yet. Failed and timed-out
 * sessions also rest with `ready_for_prompt` set, but they are never unread results.
 */
export const isUnreadResult = (session: Session): boolean =>
  !!session.ready_for_prompt &&
  !isFailure(session) &&
  isSessionStartedByUser(session) &&
  !isGatewaySession(session);

const HOME_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface HomeSessionNeed {
  key: string;
  reason: 'permission' | 'failed' | 'finished';
  at: number;
  session: Session;
  /** Older finished or failed runs on the same branch, newest first; the row stands for all of them. */
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
  /** Running sessions that pass the My work query and started-by-me filters, uncapped. */
  runningMatchCount: number;
  /** Finished-unopened runs, counted singly (Needs you groups them per branch). */
  unreadCount: number;
  /** Known, unarchived boards of the caller's latest sessions, most recent first. */
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
  /** Failed sessions the user already opened (id → `lastRunStartedAt` of the run they saw). */
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

/** Home's recent-boards row lists at most this many boards of my sessions. */
export const HOME_RECENT_BOARDS = 5;

type BoardMaps = Pick<AgorState, 'boardById' | 'branchById'>;
const isLiveBoard = (s: BoardMaps, boardId: string) => {
  const board = s.boardById.get(boardId);
  return !!board && !board.archived;
};

/** The ids of `boardIds` that name known, unarchived boards, in order. */
export const liveBoardIds = (s: BoardMaps, boardIds: readonly string[]) =>
  boardIds.filter((boardId) => isLiveBoard(s, boardId));

/** Keep the latest update of `session`'s board, if known and unarchived. */
function noteSessionBoard(boardAt: Map<string, number>, session: Session, s: BoardMaps) {
  const boardId = boardIdForSession(session, s.branchById);
  if (boardId && isLiveBoard(s, boardId) && updatedAt(session) > (boardAt.get(boardId) ?? 0))
    boardAt.set(boardId, updatedAt(session));
}

/** The `limit` boards of `boardAt`, most recently updated first. */
const latestBoards = (boardAt: Map<string, number>, limit: number) =>
  [...boardAt]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

/**
 * The boards Home's recent row lists: the visit history's live boards or,
 * with none, the boards of my latest sessions (as `boardIds` of the buckets).
 */
export function homeRecentBoardIds(
  s: Pick<AgorState, 'boardById' | 'branchById' | 'sessionById'>,
  visitedIds: readonly string[],
  userId: string | undefined
): string[] {
  const visited = liveBoardIds(s, visitedIds);
  if (visited.length || !userId) return visited;
  const boardAt = new Map<string, number>();
  for (const session of s.sessionById.values()) {
    if (!session.archived && session.created_by === userId) noteSessionBoard(boardAt, session, s);
  }
  return latestBoards(boardAt, HOME_RECENT_BOARDS);
}

/** Epoch ms of a UUIDv7 id's creation timestamp (its first 48 bits); NaN for any other id. */
const uuidV7Ms = (id: string) =>
  // shortid-guard:ignore reads the 48-bit timestamp, not a display short id
  id[14] === '7' ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : Number.NaN;

/** When the session's latest run started (server clock): its newest task's id timestamp, else its creation. */
export function lastRunStartedAt(session: Session): number {
  const tasks = session.tasks ?? [];
  // Ids carry queue time, not start: later runs read early, which errs toward keeping the failure.
  const taskMs = tasks.length ? uuidV7Ms(tasks[tasks.length - 1]) : Number.NaN;
  const createdMs = getTimeMs(session, 'created_at');
  return Math.max(Number.isFinite(taskMs) ? taskMs : 0, Number.isFinite(createdMs) ? createdMs : 0);
}

/**
 * The session ran at least once and its latest run settled without failing:
 * failed and timed-out runs leave it FAILED / TIMED_OUT, so they never count.
 * Limitation: stopped runs, and timed-out runs a daemon restart reset to IDLE, count as clean.
 */
const ranCleanly = (session: Session) =>
  session.status === SessionStatus.COMPLETED ||
  (session.status === SessionStatus.IDLE && session.tasks?.length > 0);

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
  const boardId = boardIdForSession(session, s.branchById);
  return [
    session.title,
    session.description,
    branch?.name,
    branch && getTeammateConfig(branch)?.displayName,
    boardId && s.boardById.get(boardId)?.name,
  ].some((text) => text?.toLowerCase().includes(query));
}

/**
 * The person started this session and every fork ancestor: no spawn, schedule,
 * gateway run or delegation in its lineage. An ancestor missing from the store counts as not.
 * Limitation: a fork an agent makes through MCP looks user-started (the marker is only on its task).
 * Limitation (decision Q4): the user scope loads only the caller's own sessions, not
 * other users' fork ancestors, so a clean run forked from someone else's session doesn't
 * supersede a failure once that ancestor isn't otherwise loaded.
 */
function startedByUserLineage(
  session: Session,
  s: AgorState,
  memo: Map<string, boolean>,
  dependencies: Map<string, Session | undefined>
): boolean {
  const path: string[] = [];
  let result = false;
  for (let cur: Session | undefined = session; cur; ) {
    const known = memo.get(cur.session_id);
    if (known !== undefined) {
      result = known;
      break;
    }
    if (path.includes(cur.session_id) || !isSessionStartedByUser(cur) || isGatewaySession(cur))
      break;
    path.push(cur.session_id);
    const from = cur.genealogy?.forked_from_session_id;
    if (!from) {
      result = true;
      break;
    }
    cur = s.sessionById.get(from);
    dependencies.set(from, cur);
  }
  for (const id of path) memo.set(id, result);
  return result;
}

/** A scheduled run's branch and schedule; rows without a schedule id (pre-ids, or schedule deleted) share their branch's key. */
const scheduleKey = (session: Session) => `${session.branch_id}:${session.schedule_id ?? ''}`;

/** Failures that need the person: sessions they started, including their scheduled runs, never spawned, delegated or gateway runs. */
const ownsFailure = (session: Session): boolean =>
  !session.genealogy?.parent_session_id &&
  !session.remote_relationships?.as_target?.length &&
  !isGatewaySession(session);

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
  // Need items from the previous pass only, so the cache never outgrows the current needs.
  let itemCache = new Map<string, HomeSessionNeed>();
  let prev: HomeBuckets | null = null;
  let source: [AgorState['sessionById'], AgorState['branchById'], AgorState['boardById']] | null =
    null;
  let ownSessions: Session[] = [];
  // A clean fork can depend on another user's session or a currently missing ancestor.
  const lineageDependencies = new Map<string, Session | undefined>();

  return (s) => {
    const sameBoards = source?.[1] === s.branchById && source[2] === s.boardById;
    if (prev && sameBoards && source?.[0] === s.sessionById) return prev;
    const nextOwnSessions: Session[] = [];
    for (const session of userId ? s.sessionById.values() : []) {
      if (!session.archived && session.created_by === userId) nextOwnSessions.push(session);
    }
    source = [s.sessionById, s.branchById, s.boardById];
    if (
      prev &&
      sameBoards &&
      sameItems(ownSessions, nextOwnSessions) &&
      [...lineageDependencies].every(([id, session]) => s.sessionById.get(id) === session)
    ) {
      return prev;
    }
    ownSessions = nextOwnSessions;
    lineageDependencies.clear();
    const nextItemCache = new Map<string, HomeSessionNeed>();
    const sessionNeed = (
      session: Session,
      reason: HomeSessionNeed['reason'],
      earlier?: Session[]
    ) => {
      const cached = itemCache.get(session.session_id);
      const item =
        cached?.session === session &&
        cached.reason === reason &&
        sameItems(cached.earlier ?? [], earlier ?? [])
          ? cached
          : {
              key: `session:${session.session_id}`,
              reason,
              at: updatedAt(session),
              session,
              earlier,
            };
      nextItemCache.set(session.session_id, item);
      return item;
    };

    const needs: HomeSessionNeed[] = [];
    const recent: Session[] = [];
    const running: Session[] = [];
    let needsCount = 0;
    const needsByReason = { permission: 0, failed: 0, finished: 0 };
    let runningCount = 0;
    let runningMatchCount = 0;
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
    // Needs you ignores the My work query and started-by-me filters on purpose.
    const addNeed = (session: Session, reason: HomeSessionNeed['reason'], earlier?: Session[]) => {
      needsCount++;
      needsByReason[reason]++;
      insertTopK(needs, sessionNeed(session, reason, earlier), needsLimit, needBefore);
    };

    const failures: Session[] = [];
    // Newest clean run start per branch among the caller's user-started lineages.
    const cleanRunByBranch = new Map<string, number>();
    // Newest clean scheduled run per branch and schedule: it supersedes only that schedule's failures.
    const cleanScheduledRuns = new Map<string, number>();
    const lineageMemo = new Map<string, boolean>();
    const failedByBranch = new Map<string, Session[]>();
    const finishedByBranch = new Map<string, Session[]>();
    for (const session of ownSessions) {
      hasSessions = true;
      if (boardsLimit) noteSessionBoard(boardAt, session, s);
      if (session.status === SessionStatus.RUNNING) {
        runningCount++;
        if (passes(session)) {
          runningMatchCount++;
          insertTopK(running, session, recentLimit, updatedBefore);
        }
      }
      if (ranCleanly(session)) {
        const [cleanRuns, key] = session.scheduled_from_branch
          ? [cleanScheduledRuns, scheduleKey(session)]
          : startedByUserLineage(session, s, lineageMemo, lineageDependencies)
            ? [cleanRunByBranch, session.branch_id]
            : [undefined, ''];
        const runAt = lastRunStartedAt(session);
        if (cleanRuns && runAt > (cleanRuns.get(key) ?? 0)) cleanRuns.set(key, runAt);
      }
      if (session.status === SessionStatus.AWAITING_PERMISSION) {
        addNeed(session, 'permission');
      } else if (
        isFailure(session) &&
        ownsFailure(session) &&
        updatedAt(session) >= now - HOME_FAILED_WINDOW_MS &&
        // Opening records the run it saw, so only a newer run brings it back (not a rename or fork patch).
        !(
          lastRunStartedAt(session) <=
          (openedFailures[session.session_id] ?? Number.NEGATIVE_INFINITY)
        )
      ) {
        failures.push(session);
      } else if (isUnreadResult(session)) {
        unreadCount++;
        const finished = finishedByBranch.get(session.branch_id);
        if (finished) finished.push(session);
        else finishedByBranch.set(session.branch_id, [session]);
      } else {
        addRecent(session);
      }
    }
    for (const session of failures) {
      // Superseded by a clean user-started run after the failure settled; any later patch (rename, fork) re-settles it, erring toward keeping it.
      const settledAt = updatedAt(session);
      if (
        (cleanRunByBranch.get(session.branch_id) ?? 0) > settledAt ||
        (session.scheduled_from_branch &&
          (cleanScheduledRuns.get(scheduleKey(session)) ?? 0) > settledAt)
      ) {
        addRecent(session);
        continue;
      }
      const failed = failedByBranch.get(session.branch_id);
      if (failed) failed.push(session);
      else failedByBranch.set(session.branch_id, [session]);
    }
    const addGroups = (groups: Map<string, Session[]>, reason: 'failed' | 'finished') => {
      for (const group of groups.values()) {
        const [latest, ...earlier] = group.sort((a, b) => updatedAt(b) - updatedAt(a));
        addNeed(latest, reason, earlier.length ? earlier : undefined);
      }
    };
    addGroups(failedByBranch, 'failed');
    addGroups(finishedByBranch, 'finished');
    itemCache = nextItemCache;
    const boardIds = latestBoards(boardAt, boardsLimit);

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
      runningMatchCount,
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
 * newest first; a thread leaves once the caller replied last or its board or
 * branch is archived. Recomputed when comments, branches, boards or hydration
 * change, or when a session a row depends on changes owner or disappears —
 * never for other session patches.
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
  let sessionSource: AgorState['sessionById'] | undefined;
  // Sessions the last pass looked up, and whether each belonged to the caller.
  let sessionDeps: [string, boolean][] = [];
  let result: HomeCommentNeed[] = [];
  let byKey = new Map<string, HomeCommentNeed>();
  return (s) => {
    const isMine = (sessionId: string) => s.sessionById.get(sessionId)?.created_by === userId;
    const inputs = [s.commentById, s.branchById, s.boardById, s.absentBranchIds];
    if (
      inputs.every((input, i) => input === source[i]) &&
      (s.sessionById === sessionSource || sessionDeps.every(([id, mine]) => isMine(id) === mine))
    ) {
      sessionSource = s.sessionById;
      return result;
    }
    source = inputs;
    sessionSource = s.sessionById;
    sessionDeps = [];
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
      if (!root || root.resolved || s.boardById.get(root.board_id)?.archived) continue;
      const branch = root.branch_id ? s.branchById.get(root.branch_id) : undefined;
      // The user scope resolves every candidate thread's branch: present, or
      // recorded absent (archived, deleted or invisible) — then the thread leaves.
      if (root.branch_id && (branch ? branch.archived : s.absentBranchIds.has(root.branch_id)))
        continue;
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
      const onMine = () => {
        if (root.session_id) {
          const mine = isMine(root.session_id);
          sessionDeps.push([root.session_id, mine]);
          if (mine) return true;
        }
        return !!branch && (branch.primary_owner_user_id ?? branch.created_by) === userId;
      };
      const reason = mentioned ? 'mention' : participated ? 'reply' : onMine() ? 'comment' : null;
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
 * The caller's own teammates (`'own'`), or teammates someone else owns whose
 * home board is in the store and not archived (`'shared'`).
 *
 * Precondition for `'shared'`: `boardById` holds only boards the caller may
 * see under the live board policy. This selector performs no access check of
 * its own; it treats presence in the store as visibility. The server scopes
 * board lists that way for ordinary users, but a superadmin's board list is
 * not policy-scoped, so for a superadmin the caller must filter the result
 * against the board policy before showing it.
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
