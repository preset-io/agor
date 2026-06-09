import type { Branch } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type RealtimeAccessBranchRepository,
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './realtime-access-cache';

function branch(id: string, others_can: Branch['others_can'] = 'none'): Branch {
  return { branch_id: id, others_can } as Branch;
}

describe('RealtimeAccessCache', () => {
  it('caches session branch ids until ttl expiration', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(),
      findExplicitViewUserIds: vi.fn(),
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

  it('uses separate ttl values for session and branch caches', async () => {
    let now = 1_000;
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'session')),
      findExplicitViewUserIds: vi.fn(),
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
      findExplicitViewUserIds: vi.fn(async () => ['u1']),
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
    expect(branchRepository.findExplicitViewUserIds).toHaveBeenCalledTimes(1);

    cache.invalidateBranch('b1');

    await cache.getBranchVisibility('b1');
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(2);
    expect(branchRepository.findExplicitViewUserIds).toHaveBeenCalledTimes(2);

    now += 60_001;

    await cache.getBranchVisibility('b1');
    expect(branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(3);
    expect(branchRepository.findExplicitViewUserIds).toHaveBeenCalledTimes(3);
  });

  it('represents broadly visible branches without expanding user ids', async () => {
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'session')),
      findExplicitViewUserIds: vi.fn(async () => ['u1']),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(),
    } as unknown as RealtimeAccessSessionRepository;
    const cache = new RealtimeAccessCache({
      branchRepository,
      sessionsRepository,
    });

    await expect(cache.getBranchVisibility('b1')).resolves.toEqual({
      mode: 'allAuthenticated',
    });
    expect(branchRepository.findExplicitViewUserIds).not.toHaveBeenCalled();
  });
});
