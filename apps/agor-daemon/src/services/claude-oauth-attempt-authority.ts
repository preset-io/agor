/**
 * Durable Claude OAuth attempt authority for PostgreSQL deployments.
 *
 * PostgreSQL owns lifecycle and one-shot claims. This adapter owns the secret
 * boundary: it fingerprints the raw OAuth state, seals/unseals the PKCE
 * verifier with the deployment master secret, and verifies ciphertext binding
 * before any provider exchange. SQLite intentionally does not use this class —
 * a single process keeps its attempts in memory, exactly as before.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type ClaudeOAuthAttemptClaimResult,
  type ClaudeOAuthAttemptRecord,
  ClaudeOAuthAttemptRepository,
  generateId,
  MCP_OAUTH_SECRET_ENVELOPE_VERSION,
  openMCPOAuthSecret,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  sealMCPOAuthSecret,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { ClaudeOAuthAttemptID, ClaudeOAuthSealedMaterial, UserID } from '@agor/core/types';

/** How long an attempt keeps its verifier/state before it must be restarted. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface DurableClaudeOAuthCreate {
  tenantId: string;
  userId: UserID;
  codeVerifier: string;
  state: string;
  delegatedHomeKey: string | null;
}

export interface OpenedClaudeOAuthAttempt {
  record: ClaudeOAuthAttemptRecord;
  material: ClaudeOAuthSealedMaterial;
}

export function fingerprintClaudeOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function hasOnlyExpectedMaterialShape(value: unknown): value is ClaudeOAuthSealedMaterial {
  if (!value || typeof value !== 'object') return false;
  const material = value as Partial<ClaudeOAuthSealedMaterial>;
  return (
    material.version === 1 &&
    typeof material.attemptId === 'string' &&
    typeof material.tenantId === 'string' &&
    typeof material.userId === 'string' &&
    Number.isSafeInteger(material.attemptGeneration) &&
    typeof material.codeVerifier === 'string' &&
    typeof material.state === 'string' &&
    (material.delegatedHomeKey === null || typeof material.delegatedHomeKey === 'string')
  );
}

function attemptEnvelopeBinding(input: {
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

  async create(input: DurableClaudeOAuthCreate): Promise<ClaudeOAuthAttemptID> {
    const attemptId = generateId() as ClaudeOAuthAttemptID;
    await runWithTenantDatabaseScope(this.db, input.tenantId, async (scoped) => {
      const repository = new ClaudeOAuthAttemptRepository(scoped);
      // Allocation takes the per-user transaction lock first and the tenant
      // scope holds it through sealing and create(), so a lower generation can
      // never insert after and supersede a higher one.
      const attemptGeneration = await repository.allocateAttemptGeneration(
        input.tenantId,
        input.userId
      );
      const material: ClaudeOAuthSealedMaterial = {
        version: 1,
        attemptId,
        tenantId: input.tenantId,
        userId: input.userId,
        attemptGeneration,
        codeVerifier: input.codeVerifier,
        state: input.state,
        delegatedHomeKey: input.delegatedHomeKey,
      };
      const sealedMaterial = sealMCPOAuthSecret(
        JSON.stringify(material),
        this.masterSecret!,
        'pending-exchange',
        attemptEnvelopeBinding({
          attemptId,
          tenantId: input.tenantId,
          userId: input.userId,
          attemptGeneration,
        })
      );
      await repository.create({
        tenantId: input.tenantId,
        attemptId,
        stateHash: fingerprintClaudeOAuthState(input.state),
        userId: input.userId,
        attemptGeneration,
        envelopeVersion: MCP_OAUTH_SECRET_ENVELOPE_VERSION,
        sealedMaterial,
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

  /**
   * Unseal a claimed attempt's material and verify it binds to the row it came
   * from. Every field is re-checked against the row so swapped ciphertext, a
   * superseded generation, or a foreign tenant/user cannot reach an exchange.
   */
  openClaim(record: ClaudeOAuthAttemptRecord): OpenedClaudeOAuthAttempt {
    if (record.status !== 'exchanging' || !record.exchangeClaimId || !record.sealedMaterial) {
      throw new Error('Claude OAuth attempt claim is incomplete');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        openMCPOAuthSecret(
          record.sealedMaterial,
          this.masterSecret!,
          'pending-exchange',
          attemptEnvelopeBinding({
            attemptId: record.attemptId,
            tenantId: record.tenantId,
            userId: record.userId,
            attemptGeneration: record.attemptGeneration,
          })
        )
      );
    } catch {
      throw new Error('Claude OAuth attempt material is unavailable');
    }
    if (!hasOnlyExpectedMaterialShape(parsed)) {
      throw new Error('Claude OAuth attempt material is invalid');
    }
    const material = parsed;
    if (
      material.attemptId !== record.attemptId ||
      material.tenantId !== record.tenantId ||
      material.userId !== record.userId ||
      material.attemptGeneration !== record.attemptGeneration ||
      record.envelopeVersion !== MCP_OAUTH_SECRET_ENVELOPE_VERSION ||
      !record.isCurrent ||
      fingerprintClaudeOAuthState(material.state) !== record.stateHash
    ) {
      throw new Error('Claude OAuth attempt material binding is invalid');
    }
    return { record, material };
  }

  async readLiveClaim(
    tenantId: string,
    attemptId: ClaudeOAuthAttemptID,
    claimId: string
  ): Promise<ClaudeOAuthAttemptRecord | null> {
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

  async invalidateForUser(tenantId: string, userId: UserID, failureCode: string): Promise<number> {
    return runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
      new ClaudeOAuthAttemptRepository(scoped).invalidateForUser(tenantId, userId, failureCode)
    );
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
