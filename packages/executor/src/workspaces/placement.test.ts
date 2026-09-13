import { describe, expect, it } from 'vitest';
import {
  CachePolicy,
  type Candidate,
  choosePlacement,
  evictionOrder,
  type Resident,
  underPressure,
} from './placement';

const policy = CachePolicy.parse({ minimumFreeBytes: 100, minimumFreeInodes: 10 });
const resident = (branchId = 'branch'): Resident => ({
  branchId,
  repository: 'repo',
  sessions: ['session'],
  revision: 1,
  lastUsed: 1,
  resident: true,
  generation: 'one',
  preparationMs: 10,
});
const worker = (origin: string): Candidate => ({
  origin,
  incarnation: `${origin}#1`,
  freeBytes: 1000,
  totalBytes: 1000,
  freeInodes: 100,
  totalInodes: 100,
  freeSlots: 2,
  freeCpu: 4,
  freeMemoryBytes: 1000,
  accepting: true,
  residents: [],
  ageMs: 0,
});
const input = () => ({
  owner: null,
  workers: [worker('one'), worker('two')],
  tenantId: 'tenant',
  branchId: 'branch',
  repository: 'repo',
  sessionId: 'session',
  waitedMs: 0,
  policy,
});
describe('affinity and pressure policy', () => {
  it('never routes around an unavailable active owner', () => {
    expect(choosePlacement({ ...input(), owner: 'missing' })).toMatchObject({
      wait: true,
      reason: 'owner_unavailable',
    });
  });
  it('keeps warm sessions and waits briefly for capacity before a cold fallback', () => {
    const i = input();
    i.workers[1].residents = [resident()];
    expect(choosePlacement(i).origin).toBe('two');
    i.workers[1].freeSlots = 0;
    expect(choosePlacement(i).reason).toBe('warm_queue');
    expect(choosePlacement({ ...i, waitedMs: 15000 }).origin).toBe('one');
  });
  it('ignores stale workers and has stable cold ranking regardless of list order', () => {
    const i = input(),
      first = choosePlacement(i).origin;
    expect(choosePlacement({ ...i, workers: [...i.workers].reverse() }).origin).toBe(first);
    i.workers.forEach((w) => {
      w.ageMs = 30001;
    });
    expect(choosePlacement(i).origin).toBeUndefined();
  });
  it('rejects inode exhaustion and implements high/low hysteresis', () => {
    const w = worker('one');
    w.freeInodes = 5;
    expect(choosePlacement({ ...input(), workers: [w] }).origin).toBeUndefined();
    expect(underPressure(w, policy)).toBe(true);
    w.freeInodes = 100;
    w.freeBytes = 300;
    expect(underPressure(w, policy)).toBe(false);
    expect(underPressure(w, policy, true)).toBe(true);
  });
  it('excludes active-age and pinned workspaces from eviction', () => {
    expect(
      evictionOrder(
        [
          resident(),
          { ...resident('pin'), pinned: 'conflict' },
          { ...resident('warm'), lastUsed: 999 },
        ],
        1000,
        100
      ).map((r) => r.branchId)
    ).toEqual(['branch']);
  });
});
