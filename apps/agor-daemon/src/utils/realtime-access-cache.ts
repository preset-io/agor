import type { BranchRepository, SessionRepository } from '@agor/core/db';
import type { Branch, BranchID, Session, UserID, UUID } from '@agor/core/types';
import { PERMISSION_RANK } from './branch-authorization.js';

export type BranchRealtimeVisibility =
  | { mode: 'allAuthenticated' }
  | { mode: 'explicitUsers'; userIds: Set<UserID> };

export type RealtimeAccessBranchRepository = Pick<BranchRepository, 'findById'> & {
  findExplicitViewUserIds(branchId: BranchID): Promise<UUID[]>;
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
  sessionsRepository: SessionRepository;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

function branchAllowsAllAuthenticated(branch: Branch): boolean {
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
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RealtimeAccessCacheOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async getBranchIdForSession(sessionId: string): Promise<BranchID | null> {
    const cached = this.sessionBranches.get(sessionId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.branchId;
    }

    const session = (await this.options.sessionsRepository.findById(sessionId)) as Session | null;
    const branchId = (session?.branch_id as BranchID | undefined) ?? null;
    this.sessionBranches.set(sessionId, {
      branchId,
      expiresAt: now + this.ttlMs,
    });
    return branchId;
  }

  async getBranchVisibility(branchId: BranchID): Promise<BranchRealtimeVisibility | null> {
    const cached = this.branchVisibility.get(branchId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return this.visibilityFromEntry(cached);
    }

    const branch = await this.options.branchRepository.findById(branchId);
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
      expiresAt: now + this.ttlMs,
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
