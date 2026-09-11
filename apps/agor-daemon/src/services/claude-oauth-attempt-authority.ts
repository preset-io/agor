/** Durable secret boundary and mutation coordinator for Claude OAuth in PostgreSQL HA. */

import { createHash, randomUUID } from 'node:crypto';
import {
  BOUND_SECRET_ENVELOPE_VERSION,
  type ClaudeOAuthAttemptClaimResult,
  type ClaudeOAuthAttemptRecord,
  ClaudeOAuthAttemptRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  openBoundSecret,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  sealBoundSecret,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { ClaudeOAuthAttemptID, ClaudeOAuthSealedMaterial, UserID } from '@agor/core/types';

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface DurableClaudeOAuthCreate {
  tenantId: string;
  userId: UserID;
  codeVerifier: string;
  state: string;
  delegatedHomeKey: string | null;
  claudeConfigDir?: string;
  validateRoute?: () => Promise<boolean>;
}

export interface OpenedClaudeOAuthAttempt {
  record: ClaudeOAuthAttemptRecord;
  material: ClaudeOAuthSealedMaterial;
}

export function fingerprintClaudeOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function validMaterial(value: unknown): value is ClaudeOAuthSealedMaterial {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<ClaudeOAuthSealedMaterial>;
  return (
    material.version === 1 &&
    typeof material.attemptId === 'string' &&
    typeof material.tenantId === 'string' &&
    typeof material.userId === 'string' &&
    Number.isSafeInteger(material.attemptGeneration) &&
    typeof material.codeVerifier === 'string' &&
    (material.delegatedHomeKey === null || typeof material.delegatedHomeKey === 'string') &&
    (material.claudeConfigDir === undefined || typeof material.claudeConfigDir === 'string')
  );
}

function binding(input: {
  attemptId: string;
  tenantId: string;
  userId: string;
  attemptGeneration: number;
}): string {
  return [input.tenantId, input.userId, input.attemptId, String(input.attemptGeneration)].join(
    '\0'
  );
}

export class ClaudeOAuthAttemptAuthority {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly masterSecret = process.env.AGOR_MASTER_SECRET
  ) {
    if (!masterSecret) {
      throw new Error('PostgreSQL Claude OAuth attempts require the deployment AGOR_MASTER_SECRET');
    }
  }

  private seal(material: ClaudeOAuthSealedMaterial): string {
    return sealBoundSecret(
      JSON.stringify(material),
      this.masterSecret!,
      'claude-signin-attempt',
      binding(material)
    );
  }

  async create(input: DurableClaudeOAuthCreate): Promise<ClaudeOAuthAttemptID> {
    const attemptId = generateId() as ClaudeOAuthAttemptID;
    await runWithTenantDatabaseScope(this.db, input.tenantId, async (scoped) => {
      const repository = new ClaudeOAuthAttemptRepository(scoped);
      const attemptGeneration = await repository.allocateAttemptGeneration(
        input.tenantId,
        input.userId
      );
      if (input.validateRoute && !(await input.validateRoute())) {
        throw new Error('Credential route changed before sign-in reservation');
      }
      const material: ClaudeOAuthSealedMaterial = {
        version: 1,
        attemptId,
        tenantId: input.tenantId,
        userId: input.userId,
        attemptGeneration,
        codeVerifier: input.codeVerifier,
        delegatedHomeKey: input.delegatedHomeKey,
        ...(input.claudeConfigDir ? { claudeConfigDir: input.claudeConfigDir } : {}),
      };
      await repository.create({
        tenantId: input.tenantId,
        attemptId,
        stateHash: fingerprintClaudeOAuthState(input.state),
        userId: input.userId,
        attemptGeneration,
        envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
        sealedMaterial: this.seal(material),
        ttlMs: ATTEMPT_TTL_MS,
      });
    });
    return attemptId;
  }

  async claimForExchange(
    tenantId: string,
    userId: UserID,
    attemptId: ClaudeOAuthAttemptID,
    rawState: string
  ): Promise<ClaudeOAuthAttemptClaimResult> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).claimForExchange({
        tenantId,
        userId,
        attemptId,
        stateHash: fingerprintClaudeOAuthState(rawState),
        claimId: randomUUID(),
      })
    );
  }

  openClaim(record: ClaudeOAuthAttemptRecord): OpenedClaudeOAuthAttempt {
    if (
      (record.status !== 'exchanging' && record.status !== 'persisting') ||
      !record.exchangeClaimId ||
      !record.sealedMaterial
    ) {
      throw new Error('Claude OAuth attempt claim is incomplete');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        openBoundSecret(
          record.sealedMaterial,
          this.masterSecret!,
          'claude-signin-attempt',
          binding(record)
        )
      );
    } catch {
      throw new Error('Claude OAuth attempt material is unavailable');
    }
    if (!validMaterial(parsed)) throw new Error('Claude OAuth attempt material is invalid');
    if (
      parsed.attemptId !== record.attemptId ||
      parsed.tenantId !== record.tenantId ||
      parsed.userId !== record.userId ||
      parsed.attemptGeneration !== record.attemptGeneration ||
      record.envelopeVersion !== BOUND_SECRET_ENVELOPE_VERSION ||
      !record.isCurrent
    ) {
      throw new Error('Claude OAuth attempt material binding is invalid');
    }
    return { record, material: parsed };
  }

  async readLiveClaim(tenantId: string, attemptId: ClaudeOAuthAttemptID, claimId: string) {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).readLiveClaim(tenantId, attemptId, claimId)
    );
  }

  async getForUser(tenantId: string, userId: UserID, attemptId: ClaudeOAuthAttemptID) {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).getForUser(tenantId, userId, attemptId)
    );
  }

  async getCurrentForUser(tenantId: string, userId: UserID) {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).getCurrentForUser(tenantId, userId)
    );
  }

  async finish(
    record: ClaudeOAuthAttemptRecord,
    status: 'succeeded' | 'failed' | 'ambiguous',
    options: { failureCode?: string; subscriptionType?: string | null } = {}
  ): Promise<boolean> {
    if (!record.exchangeClaimId) return false;
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).finish(
        record.tenantId,
        record.attemptId,
        record.exchangeClaimId!,
        status,
        options
      )
    );
  }

  /**
   * Revalidate, mark persisting, mutate the exact home, update user metadata,
   * and terminalize while one transaction-scoped tenant/user lock is held.
   */
  async finalize<T>(
    tenantId: string,
    userId: UserID,
    attemptId: ClaudeOAuthAttemptID,
    claimId: string,
    work: (
      material: ClaudeOAuthSealedMaterial,
      credentialGeneration: number
    ) => Promise<{
      value: T;
      subscriptionType?: string;
    }>
  ): Promise<{ outcome: 'committed'; value: T } | { outcome: 'stale' }> {
    try {
      return await runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
        const repository = new ClaudeOAuthAttemptRepository(scoped);
        await repository.lockUser(tenantId, userId);
        const live = await repository.getForUser(tenantId, userId, attemptId);
        if (!live?.isCurrent || live.status !== 'exchanging' || live.exchangeClaimId !== claimId) {
          return { outcome: 'stale' as const };
        }
        const material = this.openClaim(live).material;
        if (!(await repository.markPersisting(live))) return { outcome: 'stale' as const };
        // Attempt generation orders replacement starts; the final credential
        // write gets a fresh generation so an interim task refresh cannot
        // permanently fence a still-current login that later completes.
        const credentialGeneration = await repository.allocateAttemptGeneration(tenantId, userId);
        const completed = await work(material, credentialGeneration);
        if (
          !(await repository.finish(tenantId, attemptId, claimId, 'succeeded', {
            subscriptionType: completed.subscriptionType ?? null,
          }))
        ) {
          throw new Error('Claude OAuth completion fence was lost');
        }
        return { outcome: 'committed' as const, value: completed.value };
      });
    } catch (error) {
      // The one-shot provider exchange already happened. Rollback can restore
      // the row but cannot prove that the credential write did not happen, so
      // terminalize ambiguously and never replay or path-delete a newer winner.
      await runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
        const repository = new ClaudeOAuthAttemptRepository(scoped);
        const current = await repository.getForUser(tenantId, userId, attemptId);
        if (current?.exchangeClaimId === claimId) {
          await repository.finish(tenantId, attemptId, claimId, 'ambiguous', {
            failureCode: 'credential_persistence_ambiguous',
          });
        }
      }).catch(() => undefined);
      throw error;
    }
  }

  async invalidateForUser(tenantId: string, userId: UserID, failureCode: string): Promise<number> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).invalidateForUser(tenantId, userId, failureCode)
    );
  }

  /** Coordinate logout with finalization and allocate the filesystem tombstone generation. */
  async runCredentialMutation<T>(
    tenantId: string,
    userId: UserID,
    reason: 'signed_out' | 'credentials_changed',
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    const outcome = await runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      const repository = new ClaudeOAuthAttemptRepository(scoped);
      const generation = await repository.allocateAttemptGeneration(tenantId, userId);
      await repository.invalidateForUser(tenantId, userId, reason);
      try {
        return { ok: true as const, value: await work(generation) };
      } catch (error) {
        // Commit invalidation even when the contained writer/user mutation fails.
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Serialize a daemon-owned runtime refresh with every other credential
   * writer, but do not supersede a paste-back attempt that is still pending.
   * The refresh byte-CAS yields to a completed login/logout/route mutation;
   * a pending login later allocates a newer final-write generation and wins.
   */
  async runCredentialRefresh<T>(
    tenantId: string,
    userId: UserID,
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    return runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      const repository = new ClaudeOAuthAttemptRepository(scoped);
      const generation = await repository.allocateAttemptGeneration(tenantId, userId);
      return work(generation);
    });
  }

  /** Serialize a source/route/file read without advancing the generation. */
  async runCredentialResolution<T>(
    tenantId: string,
    userId: UserID,
    work: () => Promise<T>
  ): Promise<T> {
    return runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      await new ClaudeOAuthAttemptRepository(scoped).lockUser(tenantId, userId);
      return work();
    });
  }

  /** Lock ordering seam used by UsersService: credential lock, then role lock. */
  async lockExternalUserMutation(tenantId: string, userId: UserID): Promise<void> {
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind !== 'tenant' || !scope.transactionActive || scope.tenantId !== tenantId) {
      throw new Error('Claude credential user mutation requires its tenant transaction');
    }
    await new ClaudeOAuthAttemptRepository(scope.db).lockUser(tenantId, userId);
  }

  /** Complete an already-locked external user credential/method mutation. */
  async completeExternalUserMutation(
    tenantId: string,
    userId: UserID,
    work: (generation: number) => Promise<void>,
    reason:
      | 'credentials_changed'
      | 'execution_home_changed'
      | 'user_removed' = 'credentials_changed'
  ): Promise<void> {
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind !== 'tenant' || !scope.transactionActive || scope.tenantId !== tenantId) {
      throw new Error('Claude credential user mutation requires its tenant transaction');
    }
    const repository = new ClaudeOAuthAttemptRepository(scope.db);
    const generation = await repository.allocateAttemptGeneration(tenantId, userId);
    await repository.invalidateForUser(tenantId, userId, reason);
    await work(generation);
  }

  async maintain() {
    return runWithSystemDatabaseScope(
      this.db,
      'Claude OAuth attempt maintenance',
      (systemDb) => new ClaudeOAuthAttemptRepository(systemDb).maintain(),
      { capability: 'claude_oauth_maintenance' }
    );
  }
}
