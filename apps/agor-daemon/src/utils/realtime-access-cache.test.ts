import { type Branch, type BranchID, BranchRealtimeVisibilityMode } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  bindRealtimeAccessCacheInvalidation,
  type RealtimeAccessBranchRepository,
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './realtime-access-cache';

function branch(id: string, others_can: Branch['others_can'] = 'none'): Branch {
  return { branch_id: id, others_can } as Branch;
}

function cacheSizes(cache: RealtimeAccessCache): number[] {
  return ['branchVisibility', 'sessionBranches', 'sessionOwners'].map(
    (key) => (Reflect.get(cache, key) as Map<string, unknown>).size
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('RealtimeAccessCache', () => {
  it('caches session branch ids until ttl expiration', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(),
      findRealtimeViewUserIds: vi.fn(),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
      ttlMs: 60_000,
      now: () => now,
    });

    await expect(cache.getBranchIdForSession('s1')).resolves.toBe('b1');
    await expect(cache.getBranchIdForSession('s1')).resolves.toBe('b1');
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(1);

    now += 60_001;

    await expect(cache.getBranchIdForSession('s1')).resolves.toBe('b1');
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(2);
  });

  it('caches the session owner id and invalidates it with the session', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(),
      findRealtimeViewUserIds: vi.fn(),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
      findCreatedByBySessionId: vi.fn(async () => 'owner-1'),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
      sessionBranchTtlMs: 60_000,
      now: () => now,
    });

    await expect(cache.getSessionOwnerId('s1')).resolves.toBe('owner-1');
    await expect(cache.getSessionOwnerId('s1')).resolves.toBe('owner-1');
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(1);

    // Invalidation forces a fresh lookup on the next read.
    cache.invalidateSession('s1');
    await expect(cache.getSessionOwnerId('s1')).resolves.toBe('owner-1');
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(2);

    // And the ttl still applies.
    now += 60_001;
    await cache.getSessionOwnerId('s1');
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(3);
  });

  it('uses separate ttl values for session and branch caches', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'session')),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
      branchVisibilityTtlMs: 10,
      sessionBranchTtlMs: 100,
      now: () => now,
    });

    await cache.getBranchVisibility('b1');
    await cache.getBranchIdForSession('s1');

    now += 11;
    await cache.getBranchVisibility('b1');
    await cache.getBranchIdForSession('s1');

    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(2);
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(1);
  });

  it('caches and invalidates restricted branch visibility', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'none')),
      findRealtimeViewUserIds: vi.fn(async () => ['u1']),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
      ttlMs: 60_000,
      now: () => now,
    });

    const first = await cache.getBranchVisibility('b1');
    const second = await cache.getBranchVisibility('b1');

    expect(first).toEqual({ mode: 'explicitUsers', userIds: new Set(['u1']) });
    expect(second).toEqual({ mode: 'explicitUsers', userIds: new Set(['u1']) });
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(1);
    expect(branchRepository.findRealtimeViewUserIds).toHaveBeenCalledTimes(1);

    cache.invalidateBranch('b1');

    await cache.getBranchVisibility('b1');
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(2);
    expect(branchRepository.findRealtimeViewUserIds).toHaveBeenCalledTimes(2);

    now += 60_001;

    await cache.getBranchVisibility('b1');
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(3);
    expect(branchRepository.findRealtimeViewUserIds).toHaveBeenCalledTimes(3);
  });

  it('materializes exact viewers even when Others grants broad access', async () => {
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'session')),
      findRealtimeViewUserIds: vi.fn(async () => ['u1']),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
    });

    await expect(cache.getBranchVisibility('b1')).resolves.toEqual({
      mode: 'explicitUsers',
      userIds: new Set(['u1']),
    });
    expect(branchRepository.findRealtimeViewUserIds).toHaveBeenCalledOnce();
  });

  it('clears warmed ACL and session mappings before a replica reconnect can reuse them', async () => {
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'none')),
      findRealtimeViewUserIds: vi.fn(async () => ['u1']),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
      findCreatedByBySessionId: vi.fn(async () => 'u1'),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({ branchRepository, sessionsRepository });
    let invalidate: (() => void) | undefined;
    bindRealtimeAccessCacheInvalidation(
      {
        on(_event, listener) {
          invalidate = listener;
        },
      },
      cache
    );

    await cache.getBranchVisibility('b1');
    await cache.getBranchIdForSession('s1');
    await cache.getSessionOwnerId('s1');
    invalidate?.();
    await cache.getBranchVisibility('b1');
    await cache.getBranchIdForSession('s1');
    await cache.getSessionOwnerId('s1');

    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(2);
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(2);
    expect(sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(2);
  });

  it('does not let an in-flight visibility read restore a grant after full invalidation', async () => {
    const oldRead = deferred<Branch>();
    const branchRepository = {
      findRealtimeVisibilityBranch: vi
        .fn()
        .mockImplementationOnce(() => oldRead.promise)
        .mockResolvedValueOnce(branch('b1', 'none')),
      findRealtimeViewUserIds: vi.fn().mockResolvedValue([]),
    } as unknown as RealtimeAccessBranchRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(),
        findCreatedByBySessionId: vi.fn(),
      },
    });

    const pending = cache.getBranchVisibility('b1');
    cache.clearAll();
    oldRead.resolve(branch('b1', 'session'));

    await expect(pending).resolves.toEqual({
      mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
      userIds: new Set(),
    });
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(2);
  });

  it('retries in-flight session mappings invalidated by a branch revocation', async () => {
    const oldRead = deferred<BranchID | null>();
    const sessionsRepository = {
      findBranchIdBySessionId: vi
        .fn()
        .mockImplementationOnce(() => oldRead.promise)
        .mockResolvedValueOnce(null),
      findCreatedByBySessionId: vi.fn(),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository: {
        findRealtimeVisibilityBranch: vi.fn(),
        findRealtimeViewUserIds: vi.fn(),
      },
      sessionsRepository,
    });

    const pending = cache.getBranchIdForSession('s1');
    cache.invalidateBranch('b1');
    oldRead.resolve('b1' as BranchID);

    await expect(pending).resolves.toBeNull();
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(2);
  });

  it('reclaims expired entries in every map on the next lookup without a timer', async () => {
    let now = 1_000;
    const cache = new RealtimeAccessCache({
      branchRepository: {
        findRealtimeVisibilityBranch: vi.fn(async (id: string) => branch(id)),
        findRealtimeViewUserIds: vi.fn(async () => []),
      },
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(async () => null),
        findCreatedByBySessionId: vi.fn(async () => null),
      },
      branchVisibilityTtlMs: 10,
      sessionBranchTtlMs: 100,
      now: () => now,
    });

    for (let i = 0; i < 500; i++) {
      await cache.getBranchVisibility(`b${i}` as BranchID);
      await cache.getBranchIdForSession(`s${i}`);
      await cache.getSessionOwnerId(`s${i}`);
    }
    expect(cacheSizes(cache)).toEqual([500, 500, 500]);

    // Only branch visibility has expired; the session maps keep their entries.
    now += 11;
    await cache.getSessionOwnerId('s0');
    expect(cacheSizes(cache)).toEqual([0, 500, 500]);

    now += 100;
    await cache.getBranchVisibility('fresh' as BranchID);
    expect(cacheSizes(cache)).toEqual([1, 0, 0]);
  });

  it('bounds every map under many distinct keys, evicting oldest first', async () => {
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async (id: string) => branch(id)),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
      findCreatedByBySessionId: vi.fn(async () => 'u1'),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({ branchRepository, sessionsRepository, maxEntries: 32 });

    for (let i = 0; i < 10_000; i++) {
      await cache.getBranchVisibility(`b${i}` as BranchID);
      await cache.getBranchIdForSession(`s${i}`);
      await cache.getSessionOwnerId(`s${i}`);
    }
    expect(cacheSizes(cache)).toEqual([32, 32, 32]);

    // The newest 32 keys are still hits; the oldest was evicted and is reread.
    await cache.getBranchIdForSession('s9968');
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(10_000);
    await cache.getBranchIdForSession('s0');
    expect(sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(10_001);
    expect(cacheSizes(cache)).toEqual([32, 32, 32]);
  });

  it('applies default capacity bounds without configuration', async () => {
    const cache = new RealtimeAccessCache({
      branchRepository: {
        findRealtimeVisibilityBranch: vi.fn(async (id: string) => branch(id)),
        findRealtimeViewUserIds: vi.fn(async () => []),
      },
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(async () => null),
        findCreatedByBySessionId: vi.fn(async () => null),
      },
    });

    for (let i = 0; i < 10_050; i++) {
      if (i < 2_050) await cache.getBranchVisibility(`b${i}` as BranchID);
      await cache.getBranchIdForSession(`s${i}`);
      await cache.getSessionOwnerId(`s${i}`);
    }
    expect(cacheSizes(cache)).toEqual([2_000, 10_000, 10_000]);
  });

  it('rereads current authority for an evicted branch instead of serving a stale grant', async () => {
    let viewers = ['u1'];
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async (id: string) => branch(id)),
      findRealtimeViewUserIds: vi.fn(async (id: string) => (id === 'b1' ? viewers : [])),
    } as unknown as RealtimeAccessBranchRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(),
        findCreatedByBySessionId: vi.fn(),
      },
      maxEntries: 2,
    });

    await expect(cache.getBranchVisibility('b1')).resolves.toEqual({
      mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
      userIds: new Set(['u1']),
    });
    await cache.getBranchVisibility('b2');
    await cache.getBranchVisibility('b3');

    // Revoked in the repository without a cache invalidation reaching us.
    viewers = [];
    await expect(cache.getBranchVisibility('b1')).resolves.toEqual({
      mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
      userIds: new Set(),
    });
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(4);
  });

  it('keeps the invalidation fence when eviction and expiry run during an in-flight read', async () => {
    let now = 1_000;
    const oldGrant = deferred<string[]>();
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async (id: string) => branch(id)),
      findRealtimeViewUserIds: vi
        .fn()
        .mockImplementationOnce(() => oldGrant.promise)
        .mockResolvedValue([]),
    } as unknown as RealtimeAccessBranchRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(),
        findCreatedByBySessionId: vi.fn(),
      },
      ttlMs: 10,
      maxEntries: 1,
      now: () => now,
    });

    const pending = cache.getBranchVisibility('revoked' as BranchID);
    await vi.waitFor(() => expect(branchRepository.findRealtimeViewUserIds).toHaveBeenCalled());
    cache.invalidateBranch('revoked');
    await cache.getBranchVisibility('other' as BranchID);
    now += 11;
    await cache.getBranchVisibility('third' as BranchID);
    oldGrant.resolve(['old-authorized-user']);

    const revoked = { mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS, userIds: new Set() };
    await expect(pending).resolves.toEqual(revoked);
    await expect(cache.getBranchVisibility('revoked' as BranchID)).resolves.toEqual(revoked);
  });
});
