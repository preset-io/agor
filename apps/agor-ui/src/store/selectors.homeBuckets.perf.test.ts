import type { BoardComment, Branch, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from './agorMaps';
import type { AgorState } from './agorStore';
import { makeCommentsForYouSelector, makeHomeBucketsSelector } from './selectors';

const ME = 'user-0';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const STATUSES = ['idle', 'completed', 'running', 'failed', 'awaiting_permission', 'idle'];

// A busy tenant: 7k sessions over 400 branches and 20 people, 600 comments.
function busyTenant(): AgorState {
  const sessions = Array.from(
    { length: 7000 },
    (_, i) =>
      ({
        session_id: `s-${i}`,
        title: `Session ${i}`,
        status: STATUSES[i % STATUSES.length],
        archived: i % 17 === 0,
        created_by: `user-${i % 20}`,
        branch_id: `b-${i % 400}`,
        genealogy: { children: [] },
        scheduled_from_branch: i % 5 === 0,
        ready_for_prompt: i % 7 === 0,
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
    sessionsHydrated: true,
  } as unknown as AgorState;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

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
    const base = busyTenant();
    const buckets = bucketsSelector();
    const comments = commentsSelector();

    let t = performance.now();
    const firstBuckets = buckets(base);
    const firstComments = comments(base);
    const firstPassMs = performance.now() - t;

    // Streaming-style patches to someone else's sessions: new session and map identities.
    const patched = Array.from({ length: 30 }, (_, i) => {
      const id = `s-${i * 20 + 1}`;
      const sessionById = new Map(base.sessionById);
      sessionById.set(id, { ...base.sessionById.get(id)!, title: `token ${i}` });
      return { ...base, sessionById };
    });
    const bucketTimes: number[] = [];
    const commentHitTimes: number[] = [];
    for (const state of patched) {
      t = performance.now();
      expect(buckets(state)).toBe(firstBuckets);
      bucketTimes.push(performance.now() - t);
      t = performance.now();
      expect(comments(state)).toBe(firstComments);
      commentHitTimes.push(performance.now() - t);
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
      t = performance.now();
      expect(comments(state)).not.toBe(firstComments);
      commentTimes.push(performance.now() - t);
    }

    console.info(
      `[home-perf] 7k sessions: first pass ${firstPassMs.toFixed(1)}ms, per patch buckets ${median(bucketTimes).toFixed(2)}ms, comments memo hit ${median(commentHitTimes).toFixed(3)}ms, comments recompute ${median(commentTimes).toFixed(2)}ms`
    );
    expect(firstComments.length).toBeGreaterThan(0);
    // Well above local measurements (first pass 1.1ms, 0.35ms, 0.008ms, recompute 0.25ms), for CI headroom.
    expect(firstPassMs).toBeLessThan(20);
    expect(median(bucketTimes)).toBeLessThan(2.5);
    expect(median(commentHitTimes)).toBeLessThan(0.1);
    expect(median(commentTimes)).toBeLessThan(1.5);
  });
});
