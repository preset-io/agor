import type { Board, BoardComment, Branch, Session } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import * as entityTime from '../utils/entityTime';
import { buildSessionMaps, EMPTY_MAPS } from './agorMaps';
import type { AgorState } from './agorStore';
import {
  compareHomeNeeds,
  type HomeBucketsOptions,
  lastRunStartedAt,
  makeCommentsForYouSelector,
  makeHomeBucketsSelector,
  makeLatestOwnSessionSelector,
  makeOwnBoardActivitySelector,
  makeTeammatesSelector,
} from './selectors';

const ME = 'user-me';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
/** A session whose latest run started `h` hours ago: a UUIDv7 task id carries that start. */
const ranAt = (h: number) => {
  const hex = (NOW - h * 3_600_000).toString(16).padStart(12, '0');
  return {
    created_at: hoursAgo(h + 1),
    tasks: [`${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`],
  } as Partial<Session>;
};

const session = (id: string, extra: Partial<Session> = {}) =>
  ({
    session_id: id,
    title: `Session ${id}`,
    status: 'idle',
    archived: false,
    created_by: ME,
    branch_id: `branch-${id}`,
    genealogy: { children: [] },
    scheduled_from_branch: false,
    ready_for_prompt: false,
    last_updated: hoursAgo(1),
    ...extra,
  }) as unknown as Session;

const comment = (id: string, extra: Partial<BoardComment> = {}) =>
  ({
    comment_id: id,
    board_id: 'board-1',
    created_by: 'user-other',
    content: 'Looks good',
    resolved: false,
    created_at: hoursAgo(1),
    ...extra,
  }) as unknown as BoardComment;

const board = (id: string, archived = false) => ({ board_id: id, archived }) as Board;

const state = ({
  sessions = [],
  comments = [],
  branches = [],
  boards = [],
  absentBranchIds = [],
}: {
  sessions?: Session[];
  comments?: BoardComment[];
  branches?: Branch[];
  boards?: Board[];
  absentBranchIds?: string[];
}) =>
  ({
    ...EMPTY_MAPS,
    ...buildSessionMaps(sessions),
    commentById: new Map(comments.map((c) => [c.comment_id, c])),
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    boardById: new Map(boards.map((b) => [b.board_id, b])),
    absentBranchIds: new Set(absentBranchIds),
  }) as unknown as AgorState;

const select = (s: AgorState, options: Partial<HomeBucketsOptions> = {}) =>
  makeHomeBucketsSelector({ userId: ME, now: NOW, needsLimit: 50, recentLimit: 8, ...options })(s);

const reasons = (s: AgorState, options?: Partial<HomeBucketsOptions>) =>
  select(s, options).needs.map((n) => `${n.reason}:${n.session.session_id}`);

const comments = (s: AgorState) =>
  makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' })(s).map(
    (n) => `${n.reason}:${n.thread.comment_id}`
  );

describe('makeHomeBucketsSelector', () => {
  it('orders needs permission → failed → finished, newest first, with comments between', () => {
    const s = state({
      sessions: [
        session('finished', { ready_for_prompt: true }),
        session('failed', { status: 'failed', ready_for_prompt: true, last_updated: hoursAgo(2) }),
        session('perm-old', { status: 'awaiting_permission', last_updated: hoursAgo(5) }),
        session('perm-new', { status: 'awaiting_permission', last_updated: hoursAgo(3) }),
      ],
      comments: [comment('c1', { content: 'ping @Kasia' })],
    });
    expect(reasons(s)).toEqual([
      'permission:perm-new',
      'permission:perm-old',
      'failed:failed',
      'finished:finished',
    ]);
    const merged = [
      ...select(s).needs,
      ...makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' })(s),
    ]
      .sort(compareHomeNeeds)
      .map((n) => n.reason);
    expect(merged).toEqual(['permission', 'permission', 'mention', 'failed', 'finished']);
  });

  it('caps the preview but counts everything, and leaves needs out of recent', () => {
    const sessions = [
      ...Array.from({ length: 5 }, (_, i) =>
        session(`p${i}`, { status: 'awaiting_permission', last_updated: hoursAgo(i) })
      ),
      ...Array.from({ length: 12 }, (_, i) => session(`r${i}`, { last_updated: hoursAgo(i) })),
    ];
    const buckets = select(state({ sessions }), { needsLimit: 3 });
    expect(buckets.needs).toHaveLength(3);
    expect(buckets.needsCount).toBe(5);
    expect(buckets.needsByReason).toEqual({ permission: 5, failed: 0, finished: 0 });
    expect(buckets.recentCount).toBe(12);
    expect(buckets.recent.map((s) => s.session_id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `r${i}`)
    );
  });

  it('lists finished-not-opened only for sessions the user started', () => {
    const s = state({
      sessions: [
        session('mine', { ready_for_prompt: true }),
        session('scheduled', { ready_for_prompt: true, scheduled_from_branch: true }),
        session('spawned', {
          ready_for_prompt: true,
          genealogy: { children: [], parent_session_id: 'mine' } as Session['genealogy'],
        }),
        session('theirs', { ready_for_prompt: true, created_by: 'user-other' }),
        session('sched-perm', { scheduled_from_branch: true, status: 'awaiting_permission' }),
      ],
    });
    expect(reasons(s)).toEqual(['permission:sched-perm', 'finished:mine']);
  });

  it('groups finished-not-opened per branch behind the latest run', () => {
    const run = (id: string, h: number) =>
      session(id, { ready_for_prompt: true, branch_id: 'pipe', last_updated: hoursAgo(h) });
    const buckets = select(state({ sessions: [run('r1', 3), run('r3', 1), run('r2', 2)] }));
    expect(buckets.needsCount).toBe(1);
    expect(buckets.needsByReason.finished).toBe(1);
    expect(buckets.unreadCount).toBe(3);
    expect(buckets.needs.map((n) => n.session.session_id)).toEqual(['r3']);
    expect(buckets.needs[0].earlier?.map((e) => e.session_id)).toEqual(['r2', 'r1']);
  });

  it('lists the known, unarchived boards of the latest sessions, most recent first', () => {
    const s = state({
      sessions: [
        session('a', { branch_board_id: 'board-a', last_updated: hoursAgo(3) }),
        session('b', { branch_board_id: 'board-b', last_updated: hoursAgo(1) }),
        session('a2', { branch_board_id: 'board-a', last_updated: hoursAgo(2) }),
        session('c', { branch_board_id: 'board-c', last_updated: hoursAgo(5) }),
        session('gone', { branch_board_id: 'board-gone', last_updated: hoursAgo(0) }),
        session('arch', { branch_board_id: 'board-arch', last_updated: hoursAgo(0) }),
      ] as Session[],
      boards: [board('board-a'), board('board-b'), board('board-c'), board('board-arch', true)],
    });
    expect(select(s, { boardsLimit: 2 }).boardIds).toEqual(['board-b', 'board-a']);
    expect(select(s, { boardsLimit: 5 }).boardIds).toEqual(['board-b', 'board-a', 'board-c']);
    expect(select(s).boardIds).toEqual([]);
  });

  it('shows one failure per branch from the last 7 days', () => {
    const s = state({
      sessions: [
        session('a1', {
          status: 'failed',
          ready_for_prompt: true,
          branch_id: 'b',
          last_updated: hoursAgo(2),
        }),
        session('a2', {
          status: 'timed_out',
          ready_for_prompt: true,
          branch_id: 'b',
          last_updated: hoursAgo(1),
        }),
        session('old', {
          status: 'failed',
          ready_for_prompt: true,
          last_updated: hoursAgo(24 * 8),
        }),
      ],
    });
    expect(reasons(s)).toEqual(['failed:a2']);
    expect(select(s).needs[0].earlier?.map((e) => e.session_id)).toEqual(['a1']);
    expect(select(s).needsByReason.failed).toBe(1);
    expect(select(s).recent.map((r) => r.session_id)).toEqual(['old']);
    expect(select(s).unreadCount).toBe(0);
  });

  it('groups failures per branch so opening the row clears all of them until a new run', () => {
    const fail = (id: string, h: number) =>
      session(id, {
        status: 'failed',
        ready_for_prompt: true,
        branch_id: 'b',
        ...ranAt(h + 1),
        last_updated: hoursAgo(h),
      });
    const sessions = [fail('f1', 3), fail('f3', 1), fail('f2', 2)];
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 50,
      recentLimit: 8,
    });
    const first = selector(state({ sessions }));
    const [need] = first.needs;
    expect(first.needs).toHaveLength(1);
    expect(need.session.session_id).toBe('f3');
    expect(need.earlier?.map((e) => e.session_id)).toEqual(['f2', 'f1']);
    expect(first.recent).toEqual([]);
    expect(selector(state({ sessions: [...sessions] })).needs[0]).toBe(need);
    // What Home records when the row is opened.
    const openedFailures = Object.fromEntries(
      [need.session, ...(need.earlier ?? [])].map((f) => [f.session_id, lastRunStartedAt(f)])
    );
    expect(reasons(state({ sessions }), { openedFailures })).toEqual([]);
    const f1Rerun = { ...sessions[0], ...ranAt(0.5), last_updated: hoursAgo(0.2) } as Session;
    expect(
      reasons(state({ sessions: [f1Rerun, sessions[1], sessions[2]] }), { openedFailures })
    ).toEqual(['failed:f1']);
  });

  it('never counts a failure as a finished result, even once it no longer needs the user', () => {
    const failure = (id: string, extra: Partial<Session>) =>
      session(id, { status: 'failed', ready_for_prompt: true, ...extra });
    const s = state({
      sessions: [
        failure('old', { last_updated: hoursAgo(24 * 8) }),
        failure('opened', { branch_id: 'o' }),
        failure('superseded', { branch_id: 'b', ...ranAt(3), last_updated: hoursAgo(2) }),
        session('retry', { status: 'idle', branch_id: 'b', ...ranAt(1) }),
        session('late', {
          status: 'timed_out',
          ready_for_prompt: true,
          last_updated: hoursAgo(24 * 9),
        }),
      ],
    });
    const buckets = select(s, { openedFailures: { opened: NOW } });
    expect(buckets.needs).toEqual([]);
    expect(buckets.needsByReason).toEqual({ permission: 0, failed: 0, finished: 0 });
    expect(buckets.unreadCount).toBe(0);
    expect(buckets.recent.map((r) => r.session_id).sort()).toEqual([
      'late',
      'old',
      'opened',
      'retry',
      'superseded',
    ]);
  });

  it('drops a failure once the user started a later run on its branch that ran cleanly, or opened it', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(3),
      last_updated: hoursAgo(2),
    });
    const later = session('ok', { status: 'idle', branch_id: 'b', ...ranAt(1) });
    const completed = session('done', { status: 'completed', branch_id: 'b', ...ranAt(1) });
    const earlier = session('ok0', { status: 'idle', branch_id: 'b', ...ranAt(5) });
    // Contrived (the daemon sets the flag only after a run), but pins that a clean run needs a task.
    const neverRan = session('new', {
      status: 'idle',
      ready_for_prompt: true,
      branch_id: 'b',
      created_at: hoursAgo(1),
    });
    expect(reasons(state({ sessions: [failed, earlier] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed, neverRan] }))).toEqual(['failed:f', 'finished:new']);
    expect(reasons(state({ sessions: [failed, later] }))).toEqual([]);
    expect(reasons(state({ sessions: [failed, completed] }))).toEqual([]);
    const theirs = { ...later, created_by: 'user-other' } as Session;
    expect(reasons(state({ sessions: [failed, theirs] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed] }), { openedFailures: { f: NOW } })).toEqual([]);
    expect(
      reasons(state({ sessions: [failed] }), { openedFailures: { f: Date.parse(hoursAgo(4)) } })
    ).toEqual(['failed:f']);
  });

  it('lists failures for sessions the user started or scheduled, and permission requests from any', () => {
    const failure = (id: string, extra: Partial<Session>) =>
      session(id, { status: 'failed', ready_for_prompt: true, ...extra });
    const s = state({
      sessions: [
        failure('mine', {}),
        failure('scheduled', { scheduled_from_branch: true }),
        failure('spawned', {
          genealogy: { children: [], parent_session_id: 'mine' } as Session['genealogy'],
        }),
        session('child-perm', {
          status: 'awaiting_permission',
          genealogy: { children: [], parent_session_id: 'mine' } as Session['genealogy'],
        }),
      ],
    });
    expect(reasons(s).sort()).toEqual(['failed:mine', 'failed:scheduled', 'permission:child-perm']);
    expect(select(s).recent.map((r) => r.session_id)).toEqual(['spawned']);
  });

  it('keeps gateway runs out of failures and never lets a clean one supersede a failure', () => {
    const gateway = {
      custom_context: { gateway_source: { platform: 'slack', channel_id: 'c1', thread_id: 't1' } },
    } as Partial<Session>;
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(3),
      last_updated: hoursAgo(2),
    });
    const slackOk = session('slack-ok', {
      status: 'completed',
      branch_id: 'b',
      ...ranAt(1),
      ...gateway,
    });
    const forkOfSlack = session('fork', {
      status: 'completed',
      branch_id: 'b',
      ...ranAt(1),
      genealogy: { children: [], forked_from_session_id: 'slack-ok' } as Session['genealogy'],
    });
    expect(reasons(state({ sessions: [failed, slackOk] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed, slackOk, forkOfSlack] }))).toEqual(['failed:f']);
    const slackFail = session('slack-fail', {
      status: 'failed',
      ready_for_prompt: true,
      ...gateway,
    });
    const s = state({ sessions: [slackFail] });
    expect(reasons(s)).toEqual([]);
    expect(select(s).recent.map((r) => r.session_id)).toEqual(['slack-fail']);
  });

  it('lets a later clean scheduled run supersede only scheduled failures', () => {
    const scheduledFail = session('sf', {
      status: 'failed',
      ready_for_prompt: true,
      scheduled_from_branch: true,
      branch_id: 'nightly',
      ...ranAt(30),
      last_updated: hoursAgo(29),
    });
    const scheduledOk = session('sok', {
      status: 'completed',
      scheduled_from_branch: true,
      branch_id: 'nightly',
      ...ranAt(5),
    });
    const mineFail = session('mf', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'mine',
      ...ranAt(30),
      last_updated: hoursAgo(29),
    });
    const scheduledOnMine = { ...scheduledOk, session_id: 'sok2', branch_id: 'mine' } as Session;
    expect(reasons(state({ sessions: [scheduledFail] }))).toEqual(['failed:sf']);
    expect(reasons(state({ sessions: [scheduledFail, scheduledOk] }))).toEqual([]);
    expect(reasons(state({ sessions: [mineFail, scheduledOnMine] }))).toEqual(['failed:mf']);
    const nightlyFail = { ...scheduledFail, schedule_id: 'nightly-deploy' } as Session;
    const hourlyOk = { ...scheduledOk, schedule_id: 'hourly-lint' } as Session;
    const nightlyOk = {
      ...scheduledOk,
      session_id: 'nok',
      schedule_id: 'nightly-deploy',
    } as Session;
    expect(reasons(state({ sessions: [nightlyFail, hourlyOk] }))).toEqual(['failed:sf']);
    expect(reasons(state({ sessions: [nightlyFail, hourlyOk, nightlyOk] }))).toEqual([]);
  });

  it('treats a fork cycle or a shared ancestor consistently when deciding who started a retry', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(5),
      last_updated: hoursAgo(4),
    });
    const fork = (id: string, from: string, h: number) =>
      session(id, {
        status: 'completed',
        branch_id: 'b',
        ...ranAt(h),
        genealogy: { children: [], forked_from_session_id: from } as Session['genealogy'],
      });
    const cycleA = fork('ca', 'cb', 1);
    const cycleB = fork('cb', 'ca', 1);
    expect(reasons(state({ sessions: [failed, cycleA, cycleB] }))).toEqual(['failed:f']);
    const spawned = session('sp', {
      branch_id: 'b',
      genealogy: { children: [], parent_session_id: 'x' } as Session['genealogy'],
    });
    expect(
      reasons(state({ sessions: [failed, spawned, fork('k1', 'sp', 1), fork('k2', 'k1', 1)] }))
    ).toEqual(['failed:f']);
    const root = session('r', { branch_id: 'b', created_at: hoursAgo(9) });
    const shared = state({ sessions: [failed, root, fork('k3', 'r', 2), fork('k4', 'k3', 1)] });
    const lookup = shared.sessionById.get.bind(shared.sessionById);
    const get = vi.fn(lookup);
    shared.sessionById.get = get;
    expect(reasons(shared)).toEqual([]);
    // k4's walk stops at k3's remembered answer instead of reaching the root again.
    expect(get.mock.calls.filter(([id]) => id === 'r')).toHaveLength(1);
  });

  it('keeps an opened failure dismissed through later patches, until a new run', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      ...ranAt(3),
      last_updated: hoursAgo(1),
    });
    const opened = { openedFailures: { f: lastRunStartedAt(failed) } };
    expect(reasons(state({ sessions: [failed] }), opened)).toEqual([]);
    const reRan = { ...failed, ...ranAt(0.5) } as Session;
    expect(reasons(state({ sessions: [reRan] }), opened)).toEqual(['failed:f']);
  });

  it('lets only a clean run the user started after the failure settled supersede it', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(3),
      last_updated: hoursAgo(1),
    });
    const onBranch = (id: string, extra: Partial<Session>) =>
      session(id, { status: 'completed', branch_id: 'b', ...ranAt(0.5), ...extra });
    const lineage = (genealogy: Partial<Session['genealogy']>) => ({
      genealogy: { children: [], ...genealogy } as Session['genealogy'],
    });
    const child = onBranch('child', lineage({ parent_session_id: 'f' }));
    const childFork = onBranch('child-fork', lineage({ forked_from_session_id: 'child' }));
    const orphanFork = onBranch('orphan-fork', lineage({ forked_from_session_id: 'not-loaded' }));
    const scheduled = onBranch('sched', { scheduled_from_branch: true });
    // Started after the failed run started but before it settled: ran alongside it, not after.
    const parallel = onBranch('parallel', { status: 'idle', ...ranAt(2) });
    expect(reasons(state({ sessions: [failed, child] }))).toEqual(['failed:f']);
    for (const other of [childFork, orphanFork, scheduled, parallel])
      expect(reasons(state({ sessions: [failed, child, other] }))).toEqual(['failed:f']);
    const retry = onBranch('retry', { status: 'idle' });
    const forkRetry = onBranch('fork-retry', lineage({ forked_from_session_id: 'f' }));
    expect(reasons(state({ sessions: [failed, child, retry] }))).toEqual([]);
    expect(reasons(state({ sessions: [failed, forkRetry] }))).toEqual([]);
  });

  it('does not let a renamed older run or a timed-out later run supersede a failure', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(3),
      last_updated: hoursAgo(2),
    });
    // Renaming bumps last_updated but not when the run started.
    const renamed = session('old-ok', {
      status: 'idle',
      branch_id: 'b',
      ...ranAt(5),
      last_updated: hoursAgo(0),
    });
    expect(reasons(state({ sessions: [failed, renamed] }))).toEqual(['failed:f']);
    const timedOut = session('to', {
      status: 'timed_out',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(1),
    });
    expect(
      reasons(state({ sessions: [failed, timedOut] }), { openedFailures: { to: NOW } })
    ).toEqual(['failed:f']);
  });

  it('falls back to creation time when the latest task id is not a UUIDv7', () => {
    const failed = session('f', {
      status: 'failed',
      ready_for_prompt: true,
      branch_id: 'b',
      ...ranAt(3),
      last_updated: hoursAgo(2),
    });
    // A v4 id's leading bits are random; read as a v7 timestamp they would land far in the future.
    const v4 = session('v4', {
      status: 'idle',
      branch_id: 'b',
      created_at: hoursAgo(5),
      tasks: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
    });
    expect(reasons(state({ sessions: [failed, v4] }))).toEqual(['failed:f']);
    const v4Later = { ...v4, created_at: hoursAgo(1) } as Session;
    expect(reasons(state({ sessions: [failed, v4Later] }))).toEqual([]);
  });

  it('keeps its result identity when a patch touches nothing it shows', () => {
    const shown = session('shown', { status: 'awaiting_permission' });
    const other = session('other', { created_by: 'user-other' });
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 3,
      recentLimit: 8,
    });
    const first = selector(state({ sessions: [shown, other] }));
    expect(selector(state({ sessions: [shown, { ...other, title: 'streamed' }] }))).toBe(first);
    expect(selector(state({ sessions: [{ ...shown, title: 'renamed' }, other] }))).not.toBe(first);
  });

  it('skips bucket derivation for unrelated session patches with unchanged board maps', () => {
    const mine = session('mine', { status: 'awaiting_permission' });
    const other = session('other', { created_by: 'user-other' });
    const base = state({ sessions: [mine, other] });
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 3,
      recentLimit: 8,
    });
    const time = vi.spyOn(entityTime, 'getTimeMs');
    try {
      const first = selector(base);
      expect(time).toHaveBeenCalled();
      time.mockClear();
      const sessionById = new Map(base.sessionById);
      sessionById.set(other.session_id, { ...other, title: 'streamed' });
      expect(selector({ ...base, sessionById })).toBe(first);
      expect(selector({ ...base, sessionById })).toBe(first);
      expect(time).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  });

  it('invalidates cached buckets when sessions change owner, archive, or disappear', () => {
    const mine = session('mine');
    const other = session('other', { created_by: 'user-other' });
    const base = state({ sessions: [mine, other] });
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 3,
      recentLimit: 8,
    });
    const withSessions = (sessions: Session[]) => ({ ...base, ...buildSessionMaps(sessions) });
    expect(selector(base).recentCount).toBe(1);
    const acquired = { ...other, created_by: ME } as Session;
    expect(selector(withSessions([mine, acquired])).recentCount).toBe(2);
    expect(selector(withSessions([mine, other])).recentCount).toBe(1);
    expect(selector(withSessions([{ ...mine, archived: true }, other])).hasSessions).toBe(false);
    expect(selector(withSessions([mine, other])).recentCount).toBe(1);
    expect(selector(withSessions([other])).hasSessions).toBe(false);
  });

  it('invalidates cached buckets for branch and board changes', () => {
    const branch = { branch_id: 'b', board_id: 'board', name: 'target' } as Branch;
    const homeBoard = { ...board('board'), name: 'Workspace' };
    const base = state({
      sessions: [session('mine', { branch_id: 'b' })],
      branches: [branch],
      boards: [homeBoard],
    });
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 3,
      recentLimit: 8,
      boardsLimit: 5,
      query: 'target',
    });
    expect(selector(base).recentCount).toBe(1);
    const renamedBranch = {
      ...base,
      branchById: new Map([[branch.branch_id, { ...branch, name: 'unrelated' }]]),
    };
    expect(selector(renamedBranch).recentCount).toBe(0);
    const renamedBoard = {
      ...renamedBranch,
      boardById: new Map([[homeBoard.board_id, { ...homeBoard, name: 'target' }]]),
    };
    expect(selector(renamedBoard).recentCount).toBe(1);
    expect(selector(renamedBoard).boardIds).toEqual(['board']);
    expect(
      selector({
        ...renamedBoard,
        boardById: new Map([[homeBoard.board_id, { ...homeBoard, archived: true }]]),
      }).boardIds
    ).toEqual([]);
  });

  it('invalidates cached buckets when a foreign or missing fork ancestor changes', () => {
    const failed = session('failed', {
      branch_id: 'b',
      status: 'failed',
      ...ranAt(3),
      last_updated: hoursAgo(2),
    });
    const retry = session('retry', {
      branch_id: 'b',
      status: 'completed',
      ...ranAt(1),
      genealogy: { children: [], forked_from_session_id: 'middle' } as Session['genealogy'],
    });
    const middle = session('middle', {
      created_by: 'user-other',
      genealogy: { children: [], forked_from_session_id: 'root' } as Session['genealogy'],
    });
    const root = session('root', { created_by: 'user-other' });
    const base = state({ sessions: [failed, retry, middle] });
    const selector = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 3,
      recentLimit: 8,
    });
    const failures = (s: typeof base) =>
      selector(s)
        .needs.filter((n) => n.reason === 'failed')
        .map((n) => n.session.session_id);
    expect(failures(base)).toEqual(['failed']);
    const withRoot = (ancestor: Session) => ({
      ...base,
      sessionById: new Map(base.sessionById).set(ancestor.session_id, ancestor),
    });
    expect(failures(withRoot(root))).toEqual([]);
    expect(failures(withRoot({ ...root, scheduled_from_branch: true }))).toEqual(['failed']);
    expect(failures(withRoot(root))).toEqual([]);
    expect(failures(base)).toEqual(['failed']);
  });

  it('filters recent by title, branch, teammate or board and by who started it', () => {
    const s = state({
      sessions: [
        session('x', { branch_id: 'branch-x' }),
        session('y', { title: 'Home polish', scheduled_from_branch: true }),
        session('z'),
      ],
      branches: [{ branch_id: 'branch-x', name: 'feature-home' } as Branch],
    });
    expect(select(s, { query: 'home' }).recent.map((r) => r.session_id)).toEqual(['x', 'y']);
    expect(
      select(s, { query: 'home', onlyStartedByMe: true }).recent.map((r) => r.session_id)
    ).toEqual(['x']);
  });

  it('counts every running session that passes the My work filters, beyond the preview cap', () => {
    const running = (id: string, extra: Partial<Session> = {}) =>
      session(id, { status: 'running', title: `Home ${id}`, ...extra });
    const s = state({
      sessions: [
        running('a'),
        running('b'),
        running('c'),
        running('d', { scheduled_from_branch: true }),
        running('e', { title: 'Other work' }),
        session('idle', { title: 'Home idle' }),
      ],
    });
    const all = select(s, { recentLimit: 2 });
    expect([all.running.length, all.runningCount, all.runningMatchCount]).toEqual([2, 5, 5]);
    const filtered = select(s, { recentLimit: 2, query: 'home' });
    expect([filtered.running.length, filtered.runningCount, filtered.runningMatchCount]).toEqual([
      2, 5, 4,
    ]);
    const mine = select(s, { recentLimit: 2, query: 'home', onlyStartedByMe: true });
    expect([mine.runningCount, mine.runningMatchCount]).toEqual([5, 3]);
  });
});

describe('makeCommentsForYouSelector', () => {
  it('applies the rules: mention, reply, comment on my work; resolved or answered leave', () => {
    const s = state({
      sessions: [session('mine')],
      branches: [{ branch_id: 'my-branch', created_by: ME } as Branch],
      comments: [
        comment('mention', { content: 'what do you think @"Kasia"?', created_at: hoursAgo(1) }),
        comment('started', { created_by: ME, created_at: hoursAgo(3) }),
        comment('started-reply', {
          parent_comment_id: 'started',
          created_at: hoursAgo(2),
        } as never),
        comment('on-session', { session_id: 'mine', created_at: hoursAgo(4) } as never),
        comment('on-branch', { branch_id: 'my-branch', created_at: hoursAgo(5) } as never),
        comment('unrelated'),
        comment('resolved', { content: '@Kasia', resolved: true }),
        comment('answered', { content: '@Kasia', created_at: hoursAgo(3) }),
        comment('answered-reply', { parent_comment_id: 'answered', created_by: ME } as never),
      ],
    });
    expect(comments(s)).toEqual([
      'mention:mention',
      'reply:started',
      'comment:on-session',
      'comment:on-branch',
    ]);
  });

  it('keeps its result across session patches and unchanged comment maps', () => {
    const selector = makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' });
    const s = state({ sessions: [session('a')], comments: [comment('c', { content: '@Kasia' })] });
    const first = selector(s);
    expect(selector({ ...s, ...buildSessionMaps([session('a', { title: 'streamed' })]) })).toBe(
      first
    );
    expect(selector({ ...s, commentById: new Map(s.commentById) })).toBe(first);
    const added = new Map(s.commentById).set('d', comment('d', { content: '@Kasia again' }));
    expect(selector({ ...s, commentById: added })).toHaveLength(2);
  });

  it('recomputes when a session a row depends on changes owner or leaves the store', () => {
    const selector = makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' });
    const s = state({
      sessions: [session('mine')],
      comments: [comment('on-session', { session_id: 'mine' } as never)],
    });
    const first = selector(s);
    expect(first.map((n) => n.key)).toEqual(['comment:on-session']);
    const streamed = buildSessionMaps([session('mine', { title: 'streamed' })]);
    expect(selector({ ...s, ...streamed })).toBe(first);
    const handedOver = buildSessionMaps([session('mine', { created_by: 'user-other' })]);
    expect(selector({ ...s, ...handedOver })).toEqual([]);
    expect(selector(s)).toHaveLength(1);
    expect(selector({ ...s, ...buildSessionMaps([]) })).toEqual([]);
  });

  it('drops threads on archived boards or branches', () => {
    const ping = (id: string, extra: object) =>
      comment(id, { content: 'ping @Kasia', ...extra } as Partial<BoardComment>);
    const comments = [
      ping('on-archived-board', { board_id: 'board-arch' }),
      ping('on-archived-branch', { branch_id: 'branch-arch' }),
      ping('on-missing-branch', { branch_id: 'branch-gone' }),
      ping('on-live-branch', { branch_id: 'branch-live' }),
    ];
    const branches = [
      { branch_id: 'branch-arch', archived: true } as Branch,
      { branch_id: 'branch-live', archived: false } as Branch,
    ];
    const boards = [board('board-1'), board('board-arch', true)];
    const keys = (absentBranchIds: string[]) =>
      makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' })(
        state({ comments, branches, boards, absentBranchIds })
      )
        .map((n) => n.thread.comment_id)
        .sort();
    // Until the user scope resolves it, a missing branch may just not be loaded yet.
    expect(keys([])).toEqual(['on-live-branch', 'on-missing-branch']);
    // Once the server says it isn't there (archived, deleted or invisible), the thread leaves.
    expect(keys(['branch-gone'])).toEqual(['on-live-branch']);
  });
});

describe('board lookups follow a live branch (boardIdForSession)', () => {
  it('uses the loaded branch’s board after a move, the joined board before it loads', () => {
    const moved = session('s-moved', {
      branch_id: 'br-moved',
      branch_board_id: 'board-old',
      last_updated: new Date(NOW - 1000).toISOString(),
    } as Partial<Session>);
    const boards = [board('board-old'), board('board-new')];
    const before = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 5,
      recentLimit: 5,
      boardsLimit: 5,
    })(state({ sessions: [moved], boards }));
    expect(before.boardIds).toEqual(['board-old']);
    const after = makeHomeBucketsSelector({
      userId: ME,
      now: NOW,
      needsLimit: 5,
      recentLimit: 5,
      boardsLimit: 5,
    })(
      state({
        sessions: [moved],
        boards,
        branches: [{ branch_id: 'br-moved', board_id: 'board-new', archived: false } as Branch],
      })
    );
    expect(after.boardIds).toEqual(['board-new']);
  });
});

describe('makeOwnBoardActivitySelector', () => {
  it('reports only the caller’s running and needs-you sessions, per board', () => {
    const s = state({
      sessions: [
        session('mine-running', {
          branch_id: 'br-a',
          branch_board_id: 'board-a',
          status: 'running',
        } as Partial<Session>),
        session('mine-permission', {
          branch_id: 'br-b',
          branch_board_id: 'board-b',
          status: 'awaiting_permission',
        } as Partial<Session>),
        session('theirs-ready', {
          branch_id: 'br-c',
          branch_board_id: 'board-c',
          created_by: 'someone',
          ready_for_prompt: true,
        } as Partial<Session>),
      ],
    });
    expect(makeOwnBoardActivitySelector('board-a', ME)(s)).toEqual({
      hasRunning: true,
      hasReady: false,
    });
    expect(makeOwnBoardActivitySelector('board-b', ME)(s)).toEqual({
      hasRunning: false,
      hasReady: true,
    });
    expect(makeOwnBoardActivitySelector('board-c', ME)(s)).toEqual({
      hasRunning: false,
      hasReady: false,
    });
  });
});

describe('makeLatestOwnSessionSelector', () => {
  it('selects only the id and title of the caller’s latest session on a branch', () => {
    const s = state({
      sessions: [
        session('old', { branch_id: 'p', last_updated: hoursAgo(3) }),
        session('new', { branch_id: 'p', title: 'Latest', last_updated: hoursAgo(1) }),
        session('theirs', { branch_id: 'p', created_by: 'x', last_updated: hoursAgo(0) }),
      ],
    });
    expect(makeLatestOwnSessionSelector('p', ME)(s)).toEqual({ sessionId: 'new', title: 'Latest' });
  });
});

describe('makeTeammatesSelector', () => {
  const teammate = (id: string, boardId: string, owner = 'owner-1') =>
    ({
      branch_id: id,
      name: id,
      board_id: boardId,
      created_by: owner,
      archived: false,
      custom_context: { teammate: { kind: 'teammate', displayName: `Teammate ${id}` } },
    }) as unknown as Branch;

  it('lists others’ teammates on boards the server returned, ignoring legacy access_mode', () => {
    const s = {
      ...state({
        branches: [
          teammate('shared', 'b-shared'),
          teammate('gone-private', 'b-hidden'),
          teammate('mine', 'b-mine', ME),
        ],
      }),
      boardById: new Map([
        // Legacy access_mode is a fail-closed compatibility view, not authority.
        ['b-shared', { board_id: 'b-shared', archived: false, access_mode: 'private' }],
        ['b-mine', { board_id: 'b-mine', archived: false }],
      ]),
    } as unknown as AgorState;
    expect(makeTeammatesSelector(ME, 'shared')(s).map((b) => b.branch_id)).toEqual(['shared']);
    expect(makeTeammatesSelector(ME, 'own')(s).map((b) => b.branch_id)).toEqual(['mine']);
  });

  it('omits a branch the teammate read returned only for its enabled schedule', () => {
    // Like the daemon's primary-teammate eligibility, the lists need the marker.
    const scheduled = { ...teammate('scheduled', 'b-shared'), custom_context: {} } as Branch;
    const s = {
      ...state({ branches: [teammate('shared', 'b-shared'), scheduled] }),
      boardById: new Map([['b-shared', { board_id: 'b-shared', archived: false }]]),
    } as unknown as AgorState;
    expect(makeTeammatesSelector(ME, 'shared')(s).map((b) => b.branch_id)).toEqual(['shared']);
  });

  it('treats every unarchived board in the store as visible and runs no access check itself', () => {
    // Contract: callers whose board list is not policy-scoped must filter 'shared' themselves.
    const s = state({
      branches: [
        teammate('on-listed', 'b-listed'),
        teammate('on-archived', 'b-archived'),
        teammate('on-unlisted', 'b-unlisted'),
      ],
      boards: [board('b-listed'), board('b-archived', true)],
    });
    expect(makeTeammatesSelector(ME, 'shared')(s).map((b) => b.branch_id)).toEqual(['on-listed']);
  });
});
