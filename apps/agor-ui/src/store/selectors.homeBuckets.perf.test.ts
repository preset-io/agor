import type { BoardComment, Branch, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from './agorMaps';
import type { AgorState } from './agorStore';
import { makeCommentsForYouSelector, makeHomeBucketsSelector } from './selectors';

const ME = 'user-0';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const STATUSES = ['idle', 'completed', 'running', 'failed', 'awaiting_permission', 'idle'];
/** A UUIDv7 task id created at `ms`. */
const taskAt = (ms: number) => {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};

// A busy tenant: 7k sessions over 400 branches and 19 people, 600 comments.
function busyTenant(): AgorState {
  const sessions = Array.from(
    { length: 7000 },
    (_, i) =>
      ({
        session_id: `s-${i}`,
        title: `Session ${i}`,
        status: STATUSES[i % STATUSES.length],
        archived: i % 17 === 0,
        // 19 is coprime with the 6 statuses, so the caller (user-0) owns every status.
        created_by: `user-${i % 19}`,
        branch_id: `b-${i % 400}`,
        genealogy: { children: [] },
        scheduled_from_branch: i % 5 === 0,
        ready_for_prompt: i % 7 === 0,
        tasks: [taskAt(NOW - i * 60_000 - 30_000)],
        last_updated: new Date(NOW - i * 60_000).toISOString(),
      }) as unknown as Session
  );
  const comments = Array.from(
    { length: 600 },
    (_, i) =>
      ({
        comment_id: `c-${i}`,
        board_id: `board-${i % 30}`,
        branch_id: `b-${i % 400}`,
        parent_comment_id: i % 3 ? `c-${i - (i % 3)}` : undefined,
        created_by: `user-${(i % 19) + 1}`,
        content: i % 11 === 0 ? 'ping @Kasia' : 'looks good',
        resolved: i % 13 === 0,
        created_at: new Date(NOW - i * 30_000).toISOString(),
      }) as unknown as BoardComment
  );
  const branches = Array.from(
    { length: 400 },
    (_, i) => ({ branch_id: `b-${i}`, name: `branch-${i}`, created_by: `user-${i % 20}` }) as Branch
  );
  return {
    ...EMPTY_MAPS,
    ...buildSessionMaps(sessions),
    commentById: new Map(comments.map((c) => [c.comment_id, c])),
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    mySessionsLoaded: true,
  } as unknown as AgorState;
}

// One hot branch: 2000 of the caller's sessions, oldest first, mixing failures, clean runs and spawns.
function hotBranch(): AgorState {
  const statuses = ['failed', 'completed', 'idle', 'timed_out'];
  const sessions = Array.from(
    { length: 2000 },
    (_, i) =>
      ({
        session_id: `h-${i}`,
        title: `Run ${i}`,
        status: statuses[i % statuses.length],
        archived: false,
        created_by: ME,
        branch_id: 'hot',
        genealogy: i % 9 === 2 ? { children: [], parent_session_id: 'h-0' } : { children: [] },
        scheduled_from_branch: false,
        ready_for_prompt: true,
        tasks: [taskAt(NOW - (2000 - i) * 60_000 - 30_000)],
        last_updated: new Date(NOW - (2000 - i) * 60_000).toISOString(),
      }) as unknown as Session
  );
  return { ...EMPTY_MAPS, ...buildSessionMaps(sessions), mySessionsLoaded: true } as AgorState;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Median ms of `runs` passes, each on a freshly built state. */
function medianFreshPass(build: () => AgorState, pass: (s: AgorState) => void, runs = 5) {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = build();
    const t = performance.now();
    pass(s);
    times.push(performance.now() - t);
  }
  return median(times);
}

const bucketsSelector = () =>
  makeHomeBucketsSelector({ userId: ME, now: NOW, needsLimit: 3, recentLimit: 20, boardsLimit: 5 });
const commentsSelector = () => makeCommentsForYouSelector({ userId: ME, userName: 'Kasia' });

describe('Home selectors on a 7k-session tenant', () => {
  it('stay cheap per session patch and quiet for patches outside the previews', () => {
    // Warm up JIT on a throwaway tenant; the timed first pass then runs on fresh objects.
    for (let i = 0; i < 3; i++) {
      const warm = busyTenant();
      bucketsSelector()(warm);
      commentsSelector()(warm);
    }
    const firstPassMs = medianFreshPass(busyTenant, (s) => {
      bucketsSelector()(s);
      commentsSelector()(s);
    });
    const base = busyTenant();
    const mine = [...base.sessionById.values()].filter((s) => s.created_by === ME);
    for (const status of STATUSES) expect(mine.some((s) => s.status === status)).toBe(true);
    const buckets = bucketsSelector();
    const comments = commentsSelector();
    const firstBuckets = buckets(base);
    const firstComments = comments(base);
    expect(firstBuckets.needsByReason.failed).toBeGreaterThan(0);

    // Streaming-style patches to someone else's sessions: new session and map identities.
    const patched = Array.from({ length: 30 }, (_, i) => {
      const id = `s-${i * 19 + 1}`;
      const sessionById = new Map(base.sessionById);
      sessionById.set(id, { ...base.sessionById.get(id)!, title: `token ${i}` });
      return { ...base, sessionById };
    });
    const bucketTimes: number[] = [];
    const commentHitTimes: number[] = [];
    for (const state of patched) {
      let t = performance.now();
      const nextBuckets = buckets(state);
      bucketTimes.push(performance.now() - t);
      expect(nextBuckets).toBe(firstBuckets);
      t = performance.now();
      const nextComments = comments(state);
      commentHitTimes.push(performance.now() - t);
      expect(nextComments).toBe(firstComments);
    }

    // A new comment each time: the comments selector recomputes every thread.
    const commentTimes: number[] = [];
    for (let i = 0; i < 30; i++) {
      const commentById = new Map(base.commentById);
      commentById.set(`new-${i}`, {
        ...base.commentById.get('c-0')!,
        comment_id: `new-${i}`,
        content: 'ping @Kasia',
        resolved: false,
      });
      const state = { ...base, commentById };
      const t = performance.now();
      const nextComments = comments(state);
      commentTimes.push(performance.now() - t);
      expect(nextComments).not.toBe(firstComments);
    }

    console.info(
      `[home-perf] 7k sessions: first pass ${firstPassMs.toFixed(1)}ms, per patch buckets ${median(bucketTimes).toFixed(2)}ms, comments memo hit ${median(commentHitTimes).toFixed(3)}ms, comments recompute ${median(commentTimes).toFixed(2)}ms`
    );
    expect(firstComments.length).toBeGreaterThan(0);
    // Well above local measurements (first pass 0.8ms, 0.24ms, 0.005ms, recompute 0.17ms), for CI headroom.
    expect(firstPassMs).toBeLessThan(20);
    expect(median(bucketTimes)).toBeLessThan(2.5);
    expect(median(commentHitTimes)).toBeLessThan(0.1);
    expect(median(commentTimes)).toBeLessThan(1.5);
  });

  it("stays fast on one branch with thousands of the caller's runs, oldest first", () => {
    for (let i = 0; i < 3; i++) bucketsSelector()(hotBranch());
    let buckets = bucketsSelector()(hotBranch());
    const passMs = medianFreshPass(hotBranch, (s) => {
      buckets = bucketsSelector()(s);
    });
    console.info(`[home-perf] 2000 runs on one branch: first pass ${passMs.toFixed(1)}ms`);
    // Only the newest run, timed out after the latest clean user-started run, outlives it.
    expect(
      buckets.needs.filter((n) => n.reason === 'failed').map((n) => n.session.session_id)
    ).toEqual(['h-1999']);
    expect(buckets.recentCount).toBeGreaterThan(1000);
    // Local 1.9ms; a per-failure scan of the branch took ~120ms here.
    expect(passMs).toBeLessThan(20);
  });
});
