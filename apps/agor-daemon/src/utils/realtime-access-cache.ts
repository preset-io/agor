import {
  type BranchID,
  type BranchRealtimeVisibility,
  BranchRealtimeVisibilityMode,
  type UserID,
  type UUID,
} from '@agor/core/types';
import {
  LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
} from '../realtime/routing.js';

export type RealtimeAccessBranchRepository = {
  findRealtimeVisibilityBranch(branchId: string): Promise<{ branch_id: BranchID } | null>;
  findRealtimeViewUserIds(branchId: BranchID): Promise<UUID[]>;
};

export type RealtimeAccessSessionRepository = {
  findBranchIdBySessionId(sessionId: string): Promise<BranchID | null>;
  findCreatedByBySessionId(sessionId: string): Promise<UUID | null>;
};

type BranchVisibilityCacheEntry = BranchRealtimeVisibility & {
  expiresAt: number;
};

type SessionBranchCacheEntry = {
  branchId: BranchID | null;
  expiresAt: number;
};

type SessionOwnerCacheEntry = {
  ownerId: UserID | null;
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

/** Resolve current branch visibility without consulting daemon-local cache state. */
export async function resolveBranchRealtimeVisibility(
  repository: RealtimeAccessBranchRepository,
  branchId: BranchID
): Promise<BranchRealtimeVisibility | null> {
  const branch = await repository.findRealtimeVisibilityBranch(branchId);
  if (!branch) return null;

  return {
    mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS,
    userIds: new Set(
      (await repository.findRealtimeViewUserIds(branch.branch_id)).map((userId) => userId as UserID)
    ),
  };
}

/**
 * Daemon-local cache for realtime delivery visibility. It intentionally caches
 * branch-level access state, not socket membership, so reconnects are handled by
 * filtering the current channel connections at publish time.
 */
export class RealtimeAccessCache {
  private readonly branchVisibility = new Map<BranchID, BranchVisibilityCacheEntry>();
  private readonly sessionBranches = new Map<string, SessionBranchCacheEntry>();
  private readonly sessionOwners = new Map<string, SessionOwnerCacheEntry>();
  private readonly branchVisibilityTtlMs: number;
  private readonly sessionBranchTtlMs: number;
  private readonly now: () => number;
  /**
   * Monotonic fence for asynchronous cache fills.
   *
   * Invalidating a Map is insufficient when an older repository read is still
   * in flight: that read could otherwise repopulate the cache with a revoked
   * grant after the invalidation has completed. Every loader retries against
   * current authority when this generation changes across an await.
   */
  private generation = 0;

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

    const generation = this.generation;
    const branchId = await this.options.sessionsRepository.findBranchIdBySessionId(sessionId);
    if (generation !== this.generation) return this.getBranchIdForSession(sessionId);
    this.sessionBranches.set(sessionId, {
      branchId,
      expiresAt: this.now() + this.sessionBranchTtlMs,
    });
    return branchId;
  }

  /**
   * Owning user id for a session, cached on the same cadence as the
   * session→branch map. Used only to offer streaming events to the session
   * creator's own connections as a fallback when they haven't subscribed to
   * the per-session stream channel yet.
   */
  async getSessionOwnerId(sessionId: string): Promise<UserID | null> {
    const cached = this.sessionOwners.get(sessionId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.ownerId;
    }

    const generation = this.generation;
    const ownerId =
      ((await this.options.sessionsRepository.findCreatedByBySessionId(
        sessionId
      )) as UserID | null) ?? null;
    if (generation !== this.generation) return this.getSessionOwnerId(sessionId);
    this.sessionOwners.set(sessionId, {
      ownerId,
      expiresAt: this.now() + this.sessionBranchTtlMs,
    });
    return ownerId;
  }

  async getBranchVisibility(branchId: BranchID): Promise<BranchRealtimeVisibility | null> {
    const cached = this.branchVisibility.get(branchId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return this.visibilityFromEntry(cached);
    }

    const generation = this.generation;
    const visibility = await resolveBranchRealtimeVisibility(
      this.options.branchRepository,
      branchId
    );
    if (generation !== this.generation) return this.getBranchVisibility(branchId);
    if (!visibility) {
      this.branchVisibility.delete(branchId);
      return null;
    }

    this.branchVisibility.set(branchId, {
      ...visibility,
      expiresAt: this.now() + this.branchVisibilityTtlMs,
    });
    return visibility;
  }

  invalidateBranch(branchId: string): void {
    this.generation += 1;
    this.branchVisibility.delete(branchId as BranchID);
    for (const [sessionId, entry] of this.sessionBranches.entries()) {
      if (entry.branchId === branchId) {
        this.sessionBranches.delete(sessionId);
      }
    }
  }

  invalidateSession(sessionId: string): void {
    this.generation += 1;
    this.sessionBranches.delete(sessionId);
    this.sessionOwners.delete(sessionId);
  }

  clearVisibility(): void {
    this.generation += 1;
    this.branchVisibility.clear();
  }

  clearAll(): void {
    this.generation += 1;
    this.branchVisibility.clear();
    this.sessionBranches.clear();
    this.sessionOwners.clear();
  }

  private visibilityFromEntry(entry: BranchVisibilityCacheEntry): BranchRealtimeVisibility {
    return entry.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED
      ? { mode: BranchRealtimeVisibilityMode.ALL_AUTHENTICATED }
      : { mode: BranchRealtimeVisibilityMode.EXPLICIT_USERS, userIds: entry.userIds };
  }
}

/**
 * Bind the distributed-eviction receiver to the cache it protects. Kept beside
 * the cache so future cached authorization state cannot be added without being
 * covered by the same `clearAll()` fence.
 */
export function bindRealtimeAccessCacheInvalidation(
  eventSource: { on?: (event: string, listener: () => void) => unknown },
  cache: RealtimeAccessCache
): void {
  eventSource.on?.(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, () => cache.clearAll());
  eventSource.on?.(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, () => cache.clearAll());
}
