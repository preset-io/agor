import type { Branch, BranchID, UserID, UUID } from '@agor/core/types';
import { PERMISSION_RANK } from './branch-authorization.js';

export type BranchRealtimeVisibility =
  | { mode: 'allAuthenticated' }
  | { mode: 'explicitUsers'; userIds: Set<UserID> };

export type RealtimeAccessBranchRepository = {
  findRealtimeVisibilityBranch(
    branchId: string
  ): Promise<Pick<Branch, 'branch_id' | 'others_can'> | null>;
  findExplicitViewUserIds(branchId: BranchID): Promise<UUID[]>;
};

export type RealtimeAccessSessionRepository = {
  findBranchIdBySessionId(sessionId: string): Promise<BranchID | null>;
};

type BranchVisibilityCacheEntry = BranchRealtimeVisibility & {
  expiresAt: number;
};

type SessionBranchCacheEntry = {
  branchId: BranchID | null;
  expiresAt: number;
};

export interface RealtimeAccessCacheOptions {
  branchRepository: RealtimeAccessBranchRepository;
  sessionsRepository: RealtimeAccessSessionRepository;
  branchVisibilityTtlMs?: number;
  sessionBranchTtlMs?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_BRANCH_VISIBILITY_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_BRANCH_TTL_MS = 60 * 60_000;

function branchAllowsAllAuthenticated(branch: Pick<Branch, 'others_can'>): boolean {
  const othersCan = branch.others_can ?? 'session';
  return PERMISSION_RANK[othersCan] >= PERMISSION_RANK.view;
}

/**
 * Daemon-local cache for realtime delivery visibility. It intentionally caches
 * branch-level access state, not socket membership, so reconnects are handled by
 * filtering the current channel connections at publish time.
 */
export class RealtimeAccessCache {
  private readonly branchVisibility = new Map<BranchID, BranchVisibilityCacheEntry>();
  private readonly sessionBranches = new Map<string, SessionBranchCacheEntry>();
  private readonly branchVisibilityTtlMs: number;
  private readonly sessionBranchTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RealtimeAccessCacheOptions) {
    this.branchVisibilityTtlMs =
      options.branchVisibilityTtlMs ?? options.ttlMs ?? DEFAULT_BRANCH_VISIBILITY_TTL_MS;
    this.sessionBranchTtlMs =
      options.sessionBranchTtlMs ?? options.ttlMs ?? DEFAULT_SESSION_BRANCH_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async getBranchIdForSession(sessionId: string): Promise<BranchID | null> {
    const cached = this.sessionBranches.get(sessionId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.branchId;
    }

    const branchId = await this.options.sessionsRepository.findBranchIdBySessionId(sessionId);
    this.sessionBranches.set(sessionId, {
      branchId,
      expiresAt: now + this.sessionBranchTtlMs,
    });
    return branchId;
  }

  async getBranchVisibility(branchId: BranchID): Promise<BranchRealtimeVisibility | null> {
    const cached = this.branchVisibility.get(branchId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return this.visibilityFromEntry(cached);
    }

    const branch = await this.options.branchRepository.findRealtimeVisibilityBranch(branchId);
    if (!branch) {
      this.branchVisibility.delete(branchId);
      return null;
    }

    const visibility: BranchRealtimeVisibility = branchAllowsAllAuthenticated(branch)
      ? { mode: 'allAuthenticated' }
      : {
          mode: 'explicitUsers',
          userIds: new Set(
            (await this.options.branchRepository.findExplicitViewUserIds(branch.branch_id)).map(
              (userId) => userId as UserID
            )
          ),
        };

    this.branchVisibility.set(branch.branch_id, {
      ...visibility,
      expiresAt: now + this.branchVisibilityTtlMs,
    });
    return visibility;
  }

  invalidateBranch(branchId: string): void {
    this.branchVisibility.delete(branchId as BranchID);
    for (const [sessionId, entry] of this.sessionBranches.entries()) {
      if (entry.branchId === branchId) {
        this.sessionBranches.delete(sessionId);
      }
    }
  }

  invalidateSession(sessionId: string): void {
    this.sessionBranches.delete(sessionId);
  }

  clearVisibility(): void {
    this.branchVisibility.clear();
  }

  clearAll(): void {
    this.branchVisibility.clear();
    this.sessionBranches.clear();
  }

  private visibilityFromEntry(entry: BranchVisibilityCacheEntry): BranchRealtimeVisibility {
    return entry.mode === 'allAuthenticated'
      ? { mode: 'allAuthenticated' }
      : { mode: 'explicitUsers', userIds: entry.userIds };
  }
}
