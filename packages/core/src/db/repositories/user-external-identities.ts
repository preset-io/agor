import type { UserExternalIdentity, UserID } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { userExternalIdentities } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

export class UserExternalIdentityBindingConflictError extends RepositoryError {
  constructor(readonly identityKey: string) {
    super('External identity is already bound to a different user');
    this.name = 'UserExternalIdentityBindingConflictError';
  }
}

/**
 * Tenant-scoped persistence authority for trusted external identity bindings.
 * Callers own claim verification and user-field projection; this repository
 * owns uniqueness, serialization, and the relation's audit metadata.
 */
export class UserExternalIdentitiesRepository {
  constructor(private readonly db: Database) {}

  /** Serialize JIT projection for one subject on PostgreSQL; SQLite uses IMMEDIATE transactions. */
  async lockProvisioningKey(key: string): Promise<void> {
    if (!isPostgresDatabase(this.db)) return;
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new RepositoryError('External identity provisioning requires a tenant database scope');
    }
    const scopedKey = `${tenantId}\0${key}`;
    await executeRaw(this.db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopedKey}, 0))`);
  }

  async findByKey(key: string): Promise<typeof userExternalIdentities.$inferSelect | null> {
    return select(this.db)
      .from(userExternalIdentities)
      .where(eq(userExternalIdentities.identity_key, key))
      .one();
  }

  /**
   * Bind or refresh one verified subject. A conflicting user binding is never
   * reassigned implicitly: resolving that requires an explicit administrative
   * migration rather than an authentication side effect.
   */
  async bind(
    userId: UserID,
    identity: UserExternalIdentity,
    now: Date = new Date()
  ): Promise<typeof userExternalIdentities.$inferSelect> {
    await insert(this.db, userExternalIdentities)
      .values({
        identity_key: identity.key,
        user_id: userId,
        provider: identity.provider,
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        name: identity.name,
        last_login_at: new Date(identity.last_login_at),
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing()
      .run();

    const bound = await this.findByKey(identity.key);
    if (!bound || bound.user_id !== userId) {
      throw new UserExternalIdentityBindingConflictError(identity.key);
    }

    await update(this.db, userExternalIdentities)
      .set({
        provider: identity.provider,
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        name: identity.name,
        last_login_at: new Date(identity.last_login_at),
        updated_at: now,
      })
      .where(eq(userExternalIdentities.identity_key, identity.key))
      .run();

    return (await this.findByKey(identity.key)) ?? bound;
  }
}
