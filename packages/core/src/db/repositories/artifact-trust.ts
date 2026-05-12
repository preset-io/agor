/**
 * Artifact Trust Grants Repository
 *
 * Stores per-viewer TOFU consent for injecting env vars and daemon grants
 * into artifacts they didn't author. The viewer is `user_id`. The grant
 * matches an artifact via `(scope_type, scope_value)`:
 *
 * - 'artifact'  → scope_value = artifact_id
 * - 'author'    → scope_value = author user_id
 * - 'instance'  → scope_value = null (covers every artifact on this Agor instance)
 * - 'session'   → in-memory only; the service layer keeps these out of the DB.
 *
 * Soft-deletion: `revoked_at` is set instead of DELETE so the audit log
 * stays intact. Active grants are filtered by `revoked_at IS NULL`.
 */

import type { AgorGrants, ArtifactTrustGrant, ArtifactTrustScopeType } from '@agor/core/types';
import { and, eq, isNull } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type ArtifactTrustGrantInsert,
  type ArtifactTrustGrantRow,
  artifactTrustGrants,
} from '../schema';

export class ArtifactTrustGrantRepository {
  constructor(private db: Database) {}

  private rowToGrant(row: ArtifactTrustGrantRow): ArtifactTrustGrant {
    return {
      grant_id: row.grant_id as never,
      user_id: row.user_id as never,
      scope_type: row.scope_type as ArtifactTrustScopeType,
      scope_value: row.scope_value ?? null,
      env_vars_set: row.env_vars_set,
      agor_grants_set: row.agor_grants_set,
      granted_at: new Date(row.granted_at).toISOString(),
      revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
    };
  }

  /**
   * Persist a new trust grant.
   *
   * Note: `session`-scope grants are intentionally NOT stored here — they're
   * the caller's responsibility to keep in-memory only.
   */
  async create(input: {
    user_id: string;
    scope_type: Exclude<ArtifactTrustScopeType, 'session' | 'self'>;
    scope_value: string | null;
    env_vars_set: string[];
    agor_grants_set: AgorGrants;
  }): Promise<ArtifactTrustGrant> {
    const grantId = generateId();
    const now = new Date();

    const insertData: ArtifactTrustGrantInsert = {
      grant_id: grantId,
      user_id: input.user_id,
      scope_type: input.scope_type,
      scope_value: input.scope_value,
      env_vars_set: input.env_vars_set,
      agor_grants_set: input.agor_grants_set,
      granted_at: now,
      revoked_at: null,
    };

    await insert(this.db, artifactTrustGrants).values(insertData).run();

    const row = await select(this.db)
      .from(artifactTrustGrants)
      .where(eq(artifactTrustGrants.grant_id, grantId))
      .one();
    if (!row) throw new Error('Failed to retrieve created trust grant');
    return this.rowToGrant(row);
  }

  /**
   * Active (non-revoked) grants for a viewer.
   */
  async findActiveByUser(userId: string): Promise<ArtifactTrustGrant[]> {
    const rows = await select(this.db)
      .from(artifactTrustGrants)
      .where(and(eq(artifactTrustGrants.user_id, userId), isNull(artifactTrustGrants.revoked_at)))
      .all();
    return rows.map((r: ArtifactTrustGrantRow) => this.rowToGrant(r));
  }

  /**
   * Active grants for a viewer that match a specific scope. Used when
   * resolving consent for a single artifact.
   */
  async findActiveForScope(input: {
    userId: string;
    scopeType: Exclude<ArtifactTrustScopeType, 'session' | 'self'>;
    scopeValue: string | null;
  }): Promise<ArtifactTrustGrant[]> {
    const conditions = [
      eq(artifactTrustGrants.user_id, input.userId),
      eq(artifactTrustGrants.scope_type, input.scopeType),
      isNull(artifactTrustGrants.revoked_at),
    ];
    if (input.scopeValue === null) {
      conditions.push(isNull(artifactTrustGrants.scope_value));
    } else {
      conditions.push(eq(artifactTrustGrants.scope_value, input.scopeValue));
    }
    const rows = await select(this.db)
      .from(artifactTrustGrants)
      .where(and(...conditions))
      .all();
    return rows.map((r: ArtifactTrustGrantRow) => this.rowToGrant(r));
  }

  async findById(grantId: string): Promise<ArtifactTrustGrant | null> {
    const row = await select(this.db)
      .from(artifactTrustGrants)
      .where(eq(artifactTrustGrants.grant_id, grantId))
      .one();
    return row ? this.rowToGrant(row) : null;
  }

  /**
   * Soft-delete: set revoked_at. The row is kept for audit history.
   */
  async revoke(grantId: string): Promise<void> {
    await update(this.db, artifactTrustGrants)
      .set({ revoked_at: new Date() })
      .where(eq(artifactTrustGrants.grant_id, grantId))
      .run();
  }

  /**
   * Hard delete — for tests/admin only. Production code should use revoke().
   */
  async delete(grantId: string): Promise<void> {
    await deleteFrom(this.db, artifactTrustGrants)
      .where(eq(artifactTrustGrants.grant_id, grantId))
      .run();
  }
}
