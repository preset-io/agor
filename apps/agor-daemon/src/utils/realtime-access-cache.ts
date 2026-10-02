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
  /** Per-map entry bound; overrides both defaults below. */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_BRANCH_VISIBILITY_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_BRANCH_TTL_MS = 60 * 60_000;
/**
 * Capacity backstops for a long-running, multi-tenant daemon. TTLs already
 * bound how long an entry is useful; these bound how many can exist at once.
 * Session entries are a couple of ids (~200 B), so 10k per map is ~2 MB.
 * Branch visibility entries hold the materialized viewer set, which can be a
 * whole tenant's membership, so that map gets a smaller bound. Eviction only
 * ever forces an authorized repository reread on the next lookup.
 */
const DEFAULT_BRANCH_VISIBILITY_MAX_ENTRIES = 2_000;
const DEFAULT_SESSION_MAX_ENTRIES = 10_000;

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
  private readonly branchVisibilityMaxEntries: number;
  private readonly sessionMaxEntries: number;
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
    this.branchVisibilityMaxEntries = Math.max(
      1,
      options.maxEntries ?? DEFAULT_BRANCH_VISIBILITY_MAX_ENTRIES
    );
    this.sessionMaxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  async getBranchIdForSession(sessionId: string): Promise<BranchID | null> {
    this.pruneExpired();
    const cached = this.sessionBranches.get(sessionId);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.branchId;
    }

    const generation = this.generation;
    const branchId = await this.options.sessionsRepository.findBranchIdBySessionId(sessionId);
    if (generation !== this.generation) return this.getBranchIdForSession(sessionId);
    this.store(this.sessionBranches, sessionId, this.sessionMaxEntries, {
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
    this.pruneExpired();
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
    this.store(this.sessionOwners, sessionId, this.sessionMaxEntries, {
      ownerId,
      expiresAt: this.now() + this.sessionBranchTtlMs,
    });
    return ownerId;
  }

  async getBranchVisibility(branchId: BranchID): Promise<BranchRealtimeVisibility | null> {
    this.pruneExpired();
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

    this.store(this.branchVisibility, branchId, this.branchVisibilityMaxEntries, {
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

  /**
   * Each map has one fixed TTL and hits never refresh an entry, so insertion
   * order is expiry order: expired keys are always at the head. Sweeping every
   * map on each lookup reclaims them without a timer, in amortized O(1).
   * A backwards clock step only delays reclamation; reads still check expiry.
   */
  private pruneExpired(): void {
    const now = this.now();
    const caches: Map<string, { expiresAt: number }>[] = [
      this.branchVisibility,
      this.sessionBranches,
      this.sessionOwners,
    ];
    for (const cache of caches) {
      for (const [key, entry] of cache) {
        if (entry.expiresAt > now) break;
        cache.delete(key);
      }
    }
  }

  /** Re-insert at the tail (keeps expiry order) and evict oldest-first past the bound. */
  private store<K, V>(cache: Map<K, V>, key: K, maxEntries: number, entry: V): void {
    cache.delete(key);
    for (const oldest of cache.keys()) {
      if (cache.size < maxEntries) break;
      cache.delete(oldest);
    }
    cache.set(key, entry);
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
