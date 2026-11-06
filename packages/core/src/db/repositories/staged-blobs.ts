import type {
  StagedBlob,
  StagedBlobKind,
  StagedBlobOwner,
  TenantID,
  UploadRef,
  UserID,
} from '@agor/core/types';
import { and, asc, eq, like, lt } from 'drizzle-orm';
import type { Database, SystemDatabase } from '../client';
import { deleteFrom, insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { stagedBlobs } from '../schema';
import { RepositoryError } from './base';

type Row = typeof stagedBlobs.$inferSelect;

function logical(row: Row, tenantId: TenantID): StagedBlob {
  return {
    ref: row.blob_ref as UploadRef,
    tenantId,
    kind: row.kind as StagedBlobKind,
    scopeId: row.scope_id,
    createdBy: row.created_by as UserID,
    size: row.size_bytes,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Ownership and expiry of daemon-staged blobs (see `staged_blobs`). */
export class StagedBlobRepository {
  constructor(private readonly db: Database) {}

  /** Recorded before any byte is written, so an abandoned stage still expires. */
  async reserve(owner: StagedBlobOwner, ref: UploadRef, expiresAt: Date): Promise<void> {
    await insert(this.db, stagedBlobs)
      .values({
        blob_ref: ref,
        kind: owner.kind,
        scope_id: owner.scopeId,
        created_by: owner.createdBy,
        size_bytes: 0,
        status: 'pending',
        created_at: new Date(),
        expires_at: expiresAt,
      })
      .run();
  }

  /**
   * `reserve` for a caller-derived key: one conditional insert, false (and no
   * error, so an enclosing transaction stays usable) when the key exists.
   */
  async reserveIfAbsent(owner: StagedBlobOwner, ref: UploadRef, expiresAt: Date): Promise<boolean> {
    const rows = await insert(this.db, stagedBlobs)
      .values({
        blob_ref: ref,
        kind: owner.kind,
        scope_id: owner.scopeId,
        created_by: owner.createdBy,
        size_bytes: 0,
        status: 'pending',
        created_at: new Date(),
        expires_at: expiresAt,
      })
      .onConflictDoNothing()
      .returning()
      .all();
    return rows.length > 0;
  }

  async complete(ref: UploadRef, size: number): Promise<void> {
    await update(this.db, stagedBlobs)
      .set({ status: 'active', size_bytes: size })
      .where(eq(stagedBlobs.blob_ref, ref))
      .run();
  }

  async find(tenantId: TenantID, ref: UploadRef): Promise<StagedBlob | null> {
    const row = await select(this.db).from(stagedBlobs).where(eq(stagedBlobs.blob_ref, ref)).one();
    return row ? logical(row, tenantId) : null;
  }

  /** One creator's blobs of a kind whose scope starts with `prefix` (no LIKE wildcards). */
  async findByScopePrefix(
    tenantId: TenantID,
    kind: StagedBlobKind,
    prefix: string,
    createdBy: UserID
  ): Promise<StagedBlob[]> {
    if (/[%_\\]/.test(prefix)) throw new RepositoryError('Invalid blob scope prefix');
    const rows = await select(this.db)
      .from(stagedBlobs)
      .where(
        and(
          eq(stagedBlobs.kind, kind),
          eq(stagedBlobs.created_by, createdBy),
          like(stagedBlobs.scope_id, `${prefix}%`)
        )
      )
      .orderBy(asc(stagedBlobs.created_at))
      .all();
    return rows.map((row: Row) => logical(row, tenantId));
  }

  async remove(ref: UploadRef): Promise<void> {
    await deleteFrom(this.db, stagedBlobs).where(eq(stagedBlobs.blob_ref, ref)).run();
  }

  /**
   * Keep a blob for another TTL (an import that uses it was claimed, or its
   * worker's heartbeat ran). False when the row is gone (swept): the pack
   * must be uploaded again. On PostgreSQL the row lock it takes makes a
   * concurrent conditional delete re-check the new expiry instead of
   * removing the blob.
   */
  async extend(ref: UploadRef, expiresAt: Date): Promise<boolean> {
    const row = await update(this.db, stagedBlobs)
      .set({ expires_at: expiresAt })
      .where(eq(stagedBlobs.blob_ref, ref))
      .returning()
      .one();
    return Boolean(row);
  }

  /** Expired blobs the sweep may remove. */
  async findExpired(tenantId: TenantID, now: Date, limit?: number): Promise<StagedBlob[]> {
    let query = select(this.db)
      .from(stagedBlobs)
      .where(lt(stagedBlobs.expires_at, now))
      .orderBy(asc(stagedBlobs.expires_at));
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.all();
    return rows.map((row: Row) => logical(row, tenantId));
  }

  /**
   * The sweep's only delete: one conditional statement, so a blob is removed
   * only if it is still expired at that moment (a live import keeps extending
   * its pack). Bytes may be deleted only when this returns true.
   */
  async removeIfExpired(ref: UploadRef, now: Date): Promise<boolean> {
    const row = await deleteFrom(this.db, stagedBlobs)
      .where(and(eq(stagedBlobs.blob_ref, ref), lt(stagedBlobs.expires_at, now)))
      .returning()
      .one();
    return Boolean(row);
  }
}

/** Narrow system-scope discovery for the upload maintenance sweep. */
export async function findExpiredStagedBlobTenantIds(
  db: SystemDatabase,
  now: Date,
  limit: number
): Promise<TenantID[]> {
  const tenantColumn = (stagedBlobs as unknown as { tenant_id?: unknown }).tenant_id;
  if (!isPostgresDatabase(db) || !tenantColumn) {
    throw new RepositoryError('Cross-tenant blob maintenance requires PostgreSQL metadata');
  }
  const rows = await select(db, { tenant_id: tenantColumn })
    .from(stagedBlobs)
    .where(lt(stagedBlobs.expires_at, now))
    .groupBy(tenantColumn)
    .orderBy(tenantColumn)
    .limit(limit)
    .all();
  return (rows as Array<{ tenant_id?: unknown }>).map((row) => {
    if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
      throw new RepositoryError('Blob maintenance discovered a row without tenant identity');
    }
    return row.tenant_id as TenantID;
  });
}
