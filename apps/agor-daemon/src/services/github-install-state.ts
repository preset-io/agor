/**
 * GitHub App install state authority.
 *
 * The authenticated initiation endpoint receives a 256-bit random bearer and
 * returns it to the browser. PostgreSQL stores only SHA-256 of that bearer plus
 * its trusted tenant/admin/intent/expiry binding. The provider callback hashes
 * the presented bearer, discovers only its tenant routing ID through a narrow
 * system RLS capability, then atomically deletes it in that tenant's scope.
 *
 * Standalone SQLite retains process-local behavior for compatibility. Its Map
 * is also keyed by the hash rather than the raw bearer. PostgreSQL never falls
 * back to that Map: database failures fail closed.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  assertTenantWritable,
  GitHubInstallStateDiscoveryRepository,
  type GitHubInstallStateIssue,
  GitHubInstallStateRepository,
  isPostgresDatabaseHandle,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  TenantWriteGateActiveError,
} from '@agor/core/db';

export const GITHUB_INSTALL_STATE_INTENT = 'github-app-install';
export const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 1000;
const CLEANUP_TENANT_LIMIT = 1_000;
const STATE_BYTES = 32;
const RAW_STATE = /^[a-f0-9]{64}$/;

interface PendingState {
  userId: string;
  tenantId: string;
  intent: string;
  expiresAt: number;
}

export interface SharedInstallStateStore {
  issue(input: GitHubInstallStateIssue): Promise<void>;
  consume(
    stateHash: string,
    intent: string
  ): Promise<{ userId: string; tenantId: string; expired: boolean } | null>;
  purgeExpired(): Promise<number>;
}

export type ConsumeResult =
  | { ok: true; userId: string; tenantId: string }
  | {
      ok: false;
      reason: 'missing' | 'unknown' | 'expired' | 'user-mismatch' | 'tenant-mismatch';
    };

export interface ConsumeInstallStateOptions {
  intent?: string;
  /** Optional authenticated binding for future non-provider callback callers. */
  expectedUserId?: string;
  /** Optional authenticated binding for future non-provider callback callers. */
  expectedTenantId?: string;
}

export interface GitHubInstallStateServiceDependencies {
  db?: TenantScopeAwareDatabase;
  /** Test seam. Supplying a store selects shared-authority semantics. */
  sharedStore?: SharedInstallStateStore;
  now?: () => Date;
  startCleanupTimer?: boolean;
}

function hashInstallState(rawState: string): string {
  return createHash('sha256').update(rawState, 'utf8').digest('hex');
}

class PostgreSQLInstallStateStore implements SharedInstallStateStore {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async issue(input: GitHubInstallStateIssue): Promise<void> {
    // Commit the authority row before its raw bearer leaves the initiation
    // endpoint, independent of any surrounding request transaction.
    await runWithoutTenantDatabaseScope(() =>
      runWithTenantDatabaseScope(this.db, input.tenantId, async (scoped) => {
        await assertTenantWritable(scoped, input.tenantId);
        return new GitHubInstallStateRepository(scoped).issue(input);
      })
    );
  }

  async consume(
    stateHash: string,
    intent: string
  ): Promise<{ userId: string; tenantId: string; expired: boolean } | null> {
    // The third-party redirect has no authenticated tenant context. Possession
    // of the state is the proof, so discover only the routing tenant for the
    // exact hash+intent, leave system scope, then consume under tenant RLS.
    const tenantId = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          this.db,
          'GitHub install callback tenant discovery',
          (systemDb) =>
            new GitHubInstallStateDiscoveryRepository(systemDb).findTenantId(stateHash, intent),
          { capability: 'github_install_state_callback' }
        )
      )
    );
    if (!tenantId) return null;

    return runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
          await assertTenantWritable(scoped, tenantId);
          return new GitHubInstallStateRepository(scoped).consume(stateHash, intent);
        })
      )
    );
  }

  async purgeExpired(): Promise<number> {
    const tenantIds = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          this.db,
          'GitHub install state expiry discovery',
          (systemDb) =>
            new GitHubInstallStateDiscoveryRepository(systemDb).findExpiredTenantIds(
              CLEANUP_TENANT_LIMIT
            ),
          { capability: 'github_install_state_maintenance' }
        )
      )
    );

    let purged = 0;
    for (const tenantId of tenantIds) {
      try {
        purged += await runWithoutTenantContext(() =>
          runWithoutTenantDatabaseScope(() =>
            runWithTenantDatabaseScope(this.db, tenantId, async (scoped: TenantScopedDatabase) => {
              await assertTenantWritable(scoped, tenantId);
              return new GitHubInstallStateRepository(scoped).purgeExpired();
            })
          )
        );
      } catch (error) {
        // A portability/deletion gate deliberately freezes tenant mutations.
        // Skip that tenant without preventing cleanup for the rest of the batch.
        if (error instanceof TenantWriteGateActiveError) continue;
        throw error;
      }
    }
    return purged;
  }
}

export class GitHubInstallStateService {
  private readonly pendingStates = new Map<string, PendingState>();
  private readonly sharedStore?: SharedInstallStateStore;
  private readonly now: () => Date;
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(dependencies: GitHubInstallStateServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.sharedStore =
      dependencies.sharedStore ??
      (dependencies.db && isPostgresDatabaseHandle(dependencies.db)
        ? new PostgreSQLInstallStateStore(dependencies.db)
        : undefined);
    // The composition root always supplies its database. Keep direct
    // standalone/test construction compatible, but never let an explicitly
    // PostgreSQL process silently select the local Map.
    if (!this.sharedStore && process.env.AGOR_DB_DIALECT === 'postgresql') {
      throw new Error('GitHubInstallStateService requires its PostgreSQL database authority');
    }
    if (dependencies.startCleanupTimer !== false) this.startCleanupTimer();
  }

  /** Issue a one-time state bound to trusted authenticated context. */
  async issueInstallState(
    userId: string,
    tenantId: string,
    intent = GITHUB_INSTALL_STATE_INTENT
  ): Promise<string> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('issueInstallState requires a non-empty userId');
    }
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('issueInstallState requires a non-empty tenantId');
    }
    if (!intent || typeof intent !== 'string' || intent.length > 128) {
      throw new Error('issueInstallState requires a valid intent');
    }

    const rawState = randomBytes(STATE_BYTES).toString('hex');
    const stateHash = hashInstallState(rawState);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + GITHUB_INSTALL_STATE_TTL_MS);

    if (this.sharedStore) {
      // Fail closed before returning the raw bearer if PostgreSQL is unavailable.
      await this.sharedStore.issue({
        tenantId,
        stateHash,
        userId,
        intent,
        createdAt,
        expiresAt,
      });
    } else {
      this.pendingStates.set(stateHash, {
        userId,
        tenantId,
        intent,
        expiresAt: expiresAt.getTime(),
      });
    }

    return rawState;
  }

  /**
   * Consume a state exactly once. The provider callback omits expected identity
   * because it cannot attach browser auth; possession is the authorization
   * proof. Optional expectations preserve a safe seam for authenticated callers.
   */
  async consumeInstallState(
    rawState: string | undefined,
    options: ConsumeInstallStateOptions = {}
  ): Promise<ConsumeResult> {
    if (!rawState || typeof rawState !== 'string') {
      return { ok: false, reason: 'missing' };
    }
    if (!RAW_STATE.test(rawState)) {
      return { ok: false, reason: 'unknown' };
    }
    const intent = options.intent ?? GITHUB_INSTALL_STATE_INTENT;
    const stateHash = hashInstallState(rawState);

    let entry: { userId: string; tenantId: string; expired: boolean } | null;
    if (this.sharedStore) {
      entry = await this.sharedStore.consume(stateHash, intent);
    } else {
      const pending = this.pendingStates.get(stateHash);
      if (!pending || pending.intent !== intent) return { ok: false, reason: 'unknown' };
      this.pendingStates.delete(stateHash);
      entry = {
        userId: pending.userId,
        tenantId: pending.tenantId,
        expired: pending.expiresAt <= this.now().getTime(),
      };
    }

    if (!entry) return { ok: false, reason: 'unknown' };
    if (entry.expired) return { ok: false, reason: 'expired' };
    if (options.expectedTenantId !== undefined && entry.tenantId !== options.expectedTenantId) {
      return { ok: false, reason: 'tenant-mismatch' };
    }
    if (options.expectedUserId !== undefined && entry.userId !== options.expectedUserId) {
      return { ok: false, reason: 'user-mismatch' };
    }
    return { ok: true, userId: entry.userId, tenantId: entry.tenantId };
  }

  /** Run one local or shared expiry-cleanup pass. */
  async cleanupExpiredStates(): Promise<number> {
    if (this.sharedStore) return this.sharedStore.purgeExpired();
    const now = this.now().getTime();
    let purged = 0;
    for (const [stateHash, entry] of this.pendingStates) {
      if (entry.expiresAt <= now) {
        this.pendingStates.delete(stateHash);
        purged += 1;
      }
    }
    return purged;
  }

  close(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = undefined;
    this.pendingStates.clear();
  }

  private startCleanupTimer(): void {
    this.purgeTimer = setInterval(() => {
      void this.cleanupExpiredStates().catch(() => {
        // Never log the underlying error: it may retain a bound state hash.
        console.warn('[github-install-state] Expiry cleanup failed; will retry');
      });
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }
}

export const __testables = { hashInstallState };
