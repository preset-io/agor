import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { ProviderOAuthRefreshFence, ProviderOAuthVersion, UserID } from '../../types';
import type { Database } from '../client';
import { insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { openBoundSecretAsync, sealBoundSecret } from '../oauth-secret-envelope';
import { userProviderOauthGrants as grants } from '../schema.postgres';
import { getCurrentTenantId } from '../tenant-context';
import { ClaudeOAuthAttemptRepository } from './claude-oauth-attempts';

export type ProviderOAuthGrant = typeof grants.$inferSelect;

export interface ProviderOAuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  subscriptionType?: string;
}

/** Field and namespace separation in addition to the envelope's purpose domain. */
export function providerGrantSecretBinding(
  row: Pick<
    ProviderOAuthGrant,
    | 'tenant_id'
    | 'user_id'
    | 'provider'
    | 'grant_generation'
    | 'binding_version'
    | 'binding_fingerprint'
  >,
  field: 'access-token' | 'refresh-token'
): string {
  return JSON.stringify([
    'provider-grant',
    row.tenant_id,
    row.user_id,
    row.provider,
    row.grant_generation,
    row.binding_version,
    row.binding_fingerprint,
    field,
  ]);
}

/** Explicit tenant predicates AND RLS. Only called in short tenant transactions. */
export class UserProviderOAuthGrantRepository {
  constructor(private readonly db: Database) {
    if (!isPostgresDatabase(db)) throw new Error('Provider OAuth authority requires PostgreSQL');
  }

  private key(tenantId: string, userId: UserID) {
    if (!tenantId || getCurrentTenantId() !== tenantId) {
      throw new Error('Provider OAuth requires its trusted tenant context');
    }
    return and(
      eq(grants.tenant_id, tenantId),
      eq(grants.user_id, userId),
      eq(grants.provider, 'claude-code')
    );
  }

  private version(tenantId: string, userId: UserID, expected: ProviderOAuthVersion) {
    return and(
      this.key(tenantId, userId),
      eq(grants.grant_generation, expected.grantGeneration),
      eq(grants.binding_fingerprint, expected.bindingFingerprint),
      eq(grants.binding_version, 1),
      eq(grants.refresh_generation, expected.refreshGeneration)
    );
  }

  private fence(tenantId: string, userId: UserID, expected: ProviderOAuthRefreshFence) {
    return and(
      this.version(tenantId, userId, expected),
      eq(grants.refresh_claim_id, expected.claimId),
      eq(grants.state, 'refreshing')
    );
  }

  async get(tenantId: string, userId: UserID): Promise<ProviderOAuthGrant | null> {
    return (await select(this.db).from(grants).where(this.key(tenantId, userId)).one()) ?? null;
  }

  async open(
    row: ProviderOAuthGrant,
    field: 'access-token' | 'refresh-token',
    masterSecret: string
  ): Promise<string> {
    this.key(row.tenant_id, row.user_id as UserID);
    const envelope = field === 'access-token' ? row.sealed_access_token : row.sealed_refresh_token;
    if (!envelope) throw new Error('Provider OAuth credential unavailable');
    try {
      return await openBoundSecretAsync(
        envelope,
        masterSecret,
        field,
        providerGrantSecretBinding(row, field)
      );
    } catch {
      throw new Error('Provider OAuth credential unavailable');
    }
  }

  private seal(
    row: Parameters<typeof providerGrantSecretBinding>[0],
    pair: ProviderOAuthTokenPair,
    masterSecret: string
  ) {
    if (
      !pair.accessToken.trim() ||
      !pair.refreshToken.trim() ||
      !Number.isFinite(pair.expiresAt.getTime())
    ) {
      throw new Error('Provider OAuth token pair invalid');
    }
    return {
      sealed_access_token: sealBoundSecret(
        pair.accessToken,
        masterSecret,
        'access-token',
        providerGrantSecretBinding(row, 'access-token')
      ),
      sealed_refresh_token: sealBoundSecret(
        pair.refreshToken,
        masterSecret,
        'refresh-token',
        providerGrantSecretBinding(row, 'refresh-token')
      ),
      expires_at: pair.expiresAt,
      scopes: pair.scopes.join(' '),
      subscription_type: pair.subscriptionType?.slice(0, 64) ?? null,
    };
  }

  /** Caller holds the shared user authority and commits source + attempt in this unit. */
  async replace(
    tenantId: string,
    userId: UserID,
    generation: number,
    fingerprint: string,
    pair: ProviderOAuthTokenPair,
    masterSecret: string,
    attemptId: string
  ): Promise<void> {
    this.key(tenantId, userId);
    await new ClaudeOAuthAttemptRepository(this.db).lockUser(tenantId, userId);
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    ) {
      throw new Error('Provider OAuth binding invalid');
    }
    const binding = {
      tenant_id: tenantId,
      user_id: userId,
      provider: 'claude-code' as const,
      grant_generation: generation,
      binding_version: 1,
      binding_fingerprint: fingerprint,
    };
    const values = {
      ...binding,
      established_attempt_id: attemptId,
      ...this.seal(binding, pair, masterSecret),
      state: 'idle' as const,
      refresh_generation: 0,
      refresh_success_generation: 0,
      refresh_claim_id: null,
      refresh_claimed_at: null,
      failure_code: null,
      retry_not_before: null,
      updated_at: new Date(),
    };
    const replaced = await insert(this.db, grants)
      .values(values)
      .onConflictDoUpdate({
        target: [grants.tenant_id, grants.user_id, grants.provider],
        set: values,
        setWhere: sql`${grants.grant_generation} < ${generation}`,
      })
      .returning()
      .one();
    if (!replaced) throw new Error('Provider OAuth grant generation is stale');
  }

  /** Never delete the generation fence, nor retain secret bytes in a tombstone. */
  async retire(tenantId: string, userId: UserID, generation: number): Promise<void> {
    await new ClaudeOAuthAttemptRepository(this.db).lockUser(tenantId, userId);
    await update(this.db, grants)
      .set({
        grant_generation: generation,
        state: 'disconnected',
        sealed_access_token: null,
        sealed_refresh_token: null,
        expires_at: null,
        refresh_claim_id: null,
        refresh_claimed_at: null,
        failure_code: null,
        retry_not_before: null,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(this.key(tenantId, userId), sql`${grants.grant_generation} < ${generation}`))
      .run();
  }

  /** DB-time abandoned claims are settled, NEVER stolen or replayed. */
  async claim(
    tenantId: string,
    userId: UserID,
    expected: ProviderOAuthVersion
  ): Promise<
    | { outcome: 'claimed'; row: ProviderOAuthGrant; fence: ProviderOAuthRefreshFence }
    | { outcome: 'observed'; row: ProviderOAuthGrant | null }
  > {
    await new ClaudeOAuthAttemptRepository(this.db).lockUser(tenantId, userId);
    await update(this.db, grants)
      .set({
        state: 'ambiguous',
        failure_code: 'refresh_owner_lost',
        sealed_access_token: null,
        sealed_refresh_token: null,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          this.key(tenantId, userId),
          eq(grants.state, 'refreshing'),
          sql`${grants.refresh_claimed_at} <= CURRENT_TIMESTAMP - INTERVAL '2 minutes'`
        )
      )
      .run();
    const claimId = randomUUID();
    const result = await update(this.db, grants)
      .set({
        state: 'refreshing',
        refresh_claim_id: claimId,
        refresh_generation: expected.refreshGeneration + 1,
        refresh_claimed_at: sql`CURRENT_TIMESTAMP`,
        failure_code: null,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          this.version(tenantId, userId, expected),
          eq(grants.state, 'idle'),
          sql`(${grants.retry_not_before} IS NULL OR ${grants.retry_not_before} <= CURRENT_TIMESTAMP)`
        )
      )
      .run();
    const row = await this.get(tenantId, userId);
    if (result.rowsAffected !== 1 || !row) return { outcome: 'observed', row };
    return {
      outcome: 'claimed',
      row,
      fence: { ...expected, refreshGeneration: expected.refreshGeneration + 1, claimId },
    };
  }

  async complete(
    tenantId: string,
    userId: UserID,
    fence: ProviderOAuthRefreshFence,
    pair: ProviderOAuthTokenPair,
    masterSecret: string
  ): Promise<boolean> {
    await new ClaudeOAuthAttemptRepository(this.db).lockUser(tenantId, userId);
    const row = await this.get(tenantId, userId);
    if (!row || row.grant_generation !== fence.grantGeneration) return false;
    const result = await update(this.db, grants)
      .set({
        ...this.seal(row, pair, masterSecret),
        state: 'idle',
        refresh_success_generation: fence.refreshGeneration,
        refresh_claim_id: null,
        refresh_claimed_at: null,
        failure_code: null,
        retry_not_before: null,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where(this.fence(tenantId, userId, fence))
      .run();
    return result.rowsAffected === 1;
  }

  async finish(
    tenantId: string,
    userId: UserID,
    fence: ProviderOAuthRefreshFence,
    state: 'idle' | 'ambiguous' | 'reauth_required',
    retryMs = 0
  ): Promise<boolean> {
    await new ClaudeOAuthAttemptRepository(this.db).lockUser(tenantId, userId);
    const result = await update(this.db, grants)
      .set({
        state,
        refresh_claim_id: null,
        refresh_claimed_at: null,
        failure_code: state === 'idle' ? 'refresh_not_completed' : state,
        ...(state === 'idle' ? {} : { sealed_access_token: null, sealed_refresh_token: null }),
        retry_not_before: sql`CURRENT_TIMESTAMP + (${Math.min(300_000, Math.max(0, retryMs))} * INTERVAL '1 millisecond')`,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where(this.fence(tenantId, userId, fence))
      .run();
    return result.rowsAffected === 1;
  }
}
