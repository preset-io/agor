import type { BoardComment, Branch, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from './agorMaps';
import type { AgorState } from './agorStore';
import {
  compareHomeNeeds,
  type HomeBucketsOptions,
  makeCommentsForYouSelector,
  makeHomeBucketsSelector,
  makeLatestOwnSessionSelector,
  makeTeammatesSelector,
} from './selectors';

const ME = 'user-me';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

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

const state = ({
  sessions = [],
  comments = [],
  branches = [],
}: {
  sessions?: Session[];
  comments?: BoardComment[];
  branches?: Branch[];
}) =>
  ({
    ...EMPTY_MAPS,
    ...buildSessionMaps(sessions),
    commentById: new Map(comments.map((c) => [c.comment_id, c])),
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    sessionsHydrated: true,
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
        session('failed', { status: 'failed', last_updated: hoursAgo(2) }),
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

  it('lists the boards of the latest sessions, most recent first', () => {
    const s = state({
      sessions: [
        session('a', { branch_board_id: 'board-a', last_updated: hoursAgo(3) }),
        session('b', { branch_board_id: 'board-b', last_updated: hoursAgo(1) }),
        session('a2', { branch_board_id: 'board-a', last_updated: hoursAgo(2) }),
        session('c', { branch_board_id: 'board-c', last_updated: hoursAgo(5) }),
      ] as Session[],
    });
    expect(select(s, { boardsLimit: 2 }).boardIds).toEqual(['board-b', 'board-a']);
    expect(select(s).boardIds).toEqual([]);
  });

  it('shows one failure per branch from the last 7 days', () => {
    const s = state({
      sessions: [
        session('a1', { status: 'failed', branch_id: 'b', last_updated: hoursAgo(2) }),
        session('a2', { status: 'timed_out', branch_id: 'b', last_updated: hoursAgo(1) }),
        session('old', { status: 'failed', last_updated: hoursAgo(24 * 8) }),
      ],
    });
    expect(reasons(s)).toEqual(['failed:a2']);
    expect(select(s).recent.map((r) => r.session_id)).toEqual(['a1', 'old']);
  });

  it('drops a failure once a newer run on its branch succeeds or the user opened it', () => {
    const failed = session('f', { status: 'failed', branch_id: 'b', last_updated: hoursAgo(3) });
    const later = session('ok', { status: 'completed', branch_id: 'b', last_updated: hoursAgo(1) });
    const earlier = session('ok0', { status: 'idle', branch_id: 'b', last_updated: hoursAgo(5) });
    const untouched = session('new', { status: 'idle', branch_id: 'b', last_updated: hoursAgo(1) });
    expect(reasons(state({ sessions: [failed, earlier] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed, untouched] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed, later] }))).toEqual([]);
    const theirs = { ...later, created_by: 'user-other' } as Session;
    expect(reasons(state({ sessions: [failed, theirs] }))).toEqual(['failed:f']);
    expect(reasons(state({ sessions: [failed] }), { openedFailures: { f: NOW } })).toEqual([]);
    expect(
      reasons(state({ sessions: [failed] }), { openedFailures: { f: Date.parse(hoursAgo(4)) } })
    ).toEqual(['failed:f']);
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
});
