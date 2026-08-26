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
});
