/** Secret boundary and tenant-scoped transaction coordinator for durable Codex device auth. */

import { randomUUID } from 'node:crypto';
import {
  BOUND_SECRET_ENVELOPE_VERSION,
  type CodexDeviceAuthAttemptRecord,
  CodexDeviceAuthAttemptRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  openBoundSecret,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  sealBoundSecret,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type {
  CodexDeviceAuthAttemptID,
  CodexDeviceAuthSealedMaterial,
  UserID,
} from '@agor/core/types';
import { DEVICE_CODE_LIFETIME_MS, type UserCodeGrant } from './codex-device-auth-provider.js';

// A provider request is bounded to 15s. If a replica dies while issuing it,
// there is no safe request identifier with which another replica can resume;
// age that pre-grant state quickly instead of displaying a code-less pending
// attempt for the full device-code lifetime.
const STARTING_ATTEMPT_LIFETIME_MS = 60_000;

function binding(input: {
  tenantId: string;
  userId: string;
  attemptId: string;
  attemptGeneration: number;
}): string {
  return [input.tenantId, input.userId, input.attemptId, String(input.attemptGeneration)].join(
    '\0'
  );
}

function validMaterial(value: unknown): value is CodexDeviceAuthSealedMaterial {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<CodexDeviceAuthSealedMaterial>;
  return (
    material.version === 1 &&
    typeof material.attemptId === 'string' &&
    typeof material.tenantId === 'string' &&
    typeof material.userId === 'string' &&
    Number.isSafeInteger(material.attemptGeneration) &&
    (material.delegatedHomeKey === null || typeof material.delegatedHomeKey === 'string') &&
    (material.codexHome === undefined || typeof material.codexHome === 'string') &&
    (material.deviceAuthId === undefined || typeof material.deviceAuthId === 'string') &&
    (material.userCode === undefined || typeof material.userCode === 'string')
  );
}

export interface ReservedCodexDeviceAttempt {
  record: CodexDeviceAuthAttemptRecord;
  material: CodexDeviceAuthSealedMaterial;
}

export class CodexDeviceAuthAttemptAuthority {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly masterSecret = process.env.AGOR_MASTER_SECRET
  ) {
    if (!masterSecret) {
      throw new Error('PostgreSQL Codex device auth requires AGOR_MASTER_SECRET');
    }
  }

  private seal(material: CodexDeviceAuthSealedMaterial): string {
    return sealBoundSecret(
      JSON.stringify(material),
      this.masterSecret!,
      'codex-device-attempt',
      binding(material)
    );
  }

  open(record: CodexDeviceAuthAttemptRecord): CodexDeviceAuthSealedMaterial {
    if (!record.sealedMaterial || record.envelopeVersion !== BOUND_SECRET_ENVELOPE_VERSION) {
      throw new Error('Codex device auth attempt material is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        openBoundSecret(
          record.sealedMaterial,
          this.masterSecret!,
          'codex-device-attempt',
          binding({
            tenantId: record.tenantId,
            userId: record.userId,
            attemptId: record.attemptId,
            attemptGeneration: record.attemptGeneration,
          })
        )
      );
    } catch {
      throw new Error('Codex device auth attempt material is unavailable');
    }
    if (
      !validMaterial(parsed) ||
      parsed.tenantId !== record.tenantId ||
      parsed.userId !== record.userId ||
      parsed.attemptId !== record.attemptId ||
      parsed.attemptGeneration !== record.attemptGeneration
    ) {
      throw new Error('Codex device auth attempt material binding is invalid');
    }
    return parsed;
  }

  async reserve(input: {
    tenantId: string;
    userId: UserID;
    delegatedHomeKey: string | null;
    codexHome?: string;
    validateRoute?: () => Promise<boolean>;
  }): Promise<ReservedCodexDeviceAttempt> {
    const attemptId = generateId() as CodexDeviceAuthAttemptID;
    return runWithTenantDatabaseScope(this.db, input.tenantId, async (scoped) => {
      const repository = new CodexDeviceAuthAttemptRepository(scoped);
      const attemptGeneration = await repository.allocateGeneration(input.tenantId, input.userId);
      if (input.validateRoute && !(await input.validateRoute())) {
        throw new Error('Credential route changed before sign-in reservation');
      }
      const material: CodexDeviceAuthSealedMaterial = {
        version: 1,
        tenantId: input.tenantId,
        userId: input.userId,
        attemptId,
        attemptGeneration,
        delegatedHomeKey: input.delegatedHomeKey,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
      };
      const record = await repository.createStarting({
        tenantId: input.tenantId,
        userId: input.userId,
        attemptId,
        attemptGeneration,
        envelopeVersion: BOUND_SECRET_ENVELOPE_VERSION,
        sealedMaterial: this.seal(material),
        ttlMs: STARTING_ATTEMPT_LIFETIME_MS,
      });
      return { record, material };
    });
  }

  async attachGrant(
    reserved: ReservedCodexDeviceAttempt,
    grant: UserCodeGrant
  ): Promise<CodexDeviceAuthAttemptRecord | null> {
    const material: CodexDeviceAuthSealedMaterial = {
      ...reserved.material,
      deviceAuthId: grant.deviceAuthId,
      userCode: grant.userCode,
    };
    return runWithTenantDatabaseScope(this.db, reserved.record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).attachGrant({
        tenantId: reserved.record.tenantId,
        attemptId: reserved.record.attemptId,
        attemptGeneration: reserved.record.attemptGeneration,
        sealedMaterial: this.seal(material),
        intervalMs: grant.intervalMs,
        ttlMs: DEVICE_CODE_LIFETIME_MS,
      })
    );
  }

  async markStartingTerminal(
    record: CodexDeviceAuthAttemptRecord,
    status: 'unavailable' | 'failed',
    failureCode: string
  ): Promise<boolean> {
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).markStartingTerminal(
        record.tenantId,
        record.attemptId,
        status,
        failureCode
      )
    );
  }

  async getCurrentForUser(tenantId: string, userId: UserID) {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).getCurrentForUser(tenantId, userId)
    );
  }

  async claimPoll(record: CodexDeviceAuthAttemptRecord, leaseMs: number) {
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).claimPoll({
        tenantId: record.tenantId,
        userId: record.userId,
        attemptId: record.attemptId,
        claimId: randomUUID(),
        leaseMs,
      })
    );
  }

  async recordPending(record: CodexDeviceAuthAttemptRecord, intervalMs: number) {
    if (!record.pollClaimId) return false;
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).recordPending({
        tenantId: record.tenantId,
        attemptId: record.attemptId,
        claimId: record.pollClaimId!,
        claimGeneration: record.pollClaimGeneration,
        intervalMs,
      })
    );
  }

  async finishPoll(
    record: CodexDeviceAuthAttemptRecord,
    status: 'denied' | 'failed' | 'expired',
    failureCode: string
  ) {
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).finishPoll(record, status, failureCode)
    );
  }

  async claimExchange(record: CodexDeviceAuthAttemptRecord) {
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).claimExchange(record, randomUUID())
    );
  }

  /**
   * Serialize every credential mutation for this tenant/user. Revalidate the
   * exact generation and exchange claim after taking the lock, then keep the
   * lock through the bounded filesystem/users-service mutation and terminal
   * CAS. No provider wait happens in this transaction.
   */
  async finalize<T>(
    claimed: CodexDeviceAuthAttemptRecord,
    work: (material: CodexDeviceAuthSealedMaterial) => Promise<{ value: T; planType?: string }>
  ): Promise<{ outcome: 'committed'; value: T } | { outcome: 'stale' }> {
    try {
      return await runWithTenantDatabaseScope(this.db, claimed.tenantId, async (scoped) => {
        const repository = new CodexDeviceAuthAttemptRepository(scoped);
        await repository.lockUser(claimed.tenantId, claimed.userId);
        const live = await repository.getForUser(
          claimed.tenantId,
          claimed.userId,
          claimed.attemptId
        );
        if (
          !live?.isCurrent ||
          live.status !== 'exchanging' ||
          live.attemptGeneration !== claimed.attemptGeneration ||
          live.exchangeClaimId !== claimed.exchangeClaimId
        ) {
          return { outcome: 'stale' as const };
        }
        const material = this.open(live);
        if (!(await repository.markPersisting(live))) return { outcome: 'stale' as const };
        const completed = await work(material);
        if (
          !(await repository.finishExchange(live, 'succeeded', {
            planType: completed.planType,
          }))
        ) {
          throw new Error('Codex device auth completion fence was lost');
        }
        return { outcome: 'committed' as const, value: completed.value };
      });
    } catch (error) {
      // The transaction above rolled back, so the claim is still exchangeable
      // only in appearance. Never replay a possibly completed exchange/write.
      await runWithTenantDatabaseScope(this.db, claimed.tenantId, (scoped) =>
        new CodexDeviceAuthAttemptRepository(scoped).finishExchange(claimed, 'ambiguous', {
          failureCode: 'credential_persistence_ambiguous',
        })
      ).catch(() => undefined);
      throw error;
    }
  }

  async failExchange(
    record: CodexDeviceAuthAttemptRecord,
    status: 'failed' | 'ambiguous',
    failureCode: string
  ) {
    return runWithTenantDatabaseScope(this.db, record.tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).finishExchange(record, status, { failureCode })
    );
  }

  async cancel(
    tenantId: string,
    userId: UserID,
    attemptId: CodexDeviceAuthAttemptID
  ): Promise<number> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new CodexDeviceAuthAttemptRepository(scoped).invalidateForUser(
        tenantId,
        userId,
        'cancelled',
        'cancelled_by_user',
        attemptId
      )
    );
  }

  /** Coordinate import/logout against device finalization. */
  async runCredentialMutation<T>(
    tenantId: string,
    userId: UserID,
    reason: 'credentials_imported' | 'credentials_removed',
    work: (authorityGeneration?: number) => Promise<T>,
    preflight?: () => Promise<void>
  ): Promise<T> {
    const outcome = await runWithTenantDatabaseScope(this.db, tenantId, async (scoped) => {
      const repository = new CodexDeviceAuthAttemptRepository(scoped);
      await repository.lockUser(tenantId, userId);
      await preflight?.();
      const authorityGeneration = await repository.allocateGeneration(tenantId, userId);
      await repository.invalidateForUser(tenantId, userId, 'superseded', reason);
      try {
        return { ok: true as const, value: await work(authorityGeneration) };
      } catch (error) {
        // Catch inside the transaction so invalidation commits. Re-throw only
        // after release; a failed logout/import must not leave a poller live.
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Complete an already shared-locked users-service route/removal mutation. */
  async completeExternalUserRouteMutation(
    tenantId: string,
    userId: UserID,
    work: (authorityGeneration?: number) => Promise<void>,
    reason: 'execution_home_changed' | 'user_removed'
  ): Promise<void> {
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind !== 'tenant' || !scope.transactionActive || scope.tenantId !== tenantId) {
      throw new Error('Codex credential user mutation requires its tenant transaction');
    }
    const repository = new CodexDeviceAuthAttemptRepository(scope.db);
    const authorityGeneration = await repository.allocateGeneration(tenantId, userId);
    await repository.invalidateForUser(tenantId, userId, 'superseded', reason);
    await work(authorityGeneration);
  }

  async maintain() {
    return runWithSystemDatabaseScope(
      this.db,
      'Codex device auth attempt maintenance',
      (scoped) => new CodexDeviceAuthAttemptRepository(scoped).maintain(),
      { capability: 'codex_device_auth_maintenance' }
    );
  }
}
