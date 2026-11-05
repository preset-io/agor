import type {
  StagedBlob,
  StagedBlobKind,
  StagedBlobOwner,
  TenantID,
  UploadRef,
  UserID,
} from '@agor/core/types';
import { and, asc, eq, lt, not, sql } from 'drizzle-orm';
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

  async remove(ref: UploadRef): Promise<void> {
    await deleteFrom(this.db, stagedBlobs).where(eq(stagedBlobs.blob_ref, ref)).run();
  }

  /** Keep a blob for another TTL (an import that uses it was claimed again). */
  async extend(ref: UploadRef, expiresAt: Date): Promise<void> {
    await update(this.db, stagedBlobs)
      .set({ expires_at: expiresAt })
      .where(eq(stagedBlobs.blob_ref, ref))
      .run();
  }

  /**
   * Expired blobs, except a pack an import is still applying (its receipt
   * points at `<scope>:<ref>`): those are never swept from under a worker.
   */
  async findExpired(tenantId: TenantID, now: Date, limit?: number): Promise<StagedBlob[]> {
    const inUse = sql`exists (select 1 from agor_pack_imports i where i.status = 'applying' and i.staging_ref = staged_blobs.scope_id || ':' || staged_blobs.blob_ref)`;
    let query = select(this.db)
      .from(stagedBlobs)
      .where(and(lt(stagedBlobs.expires_at, now), not(inUse)))
      .orderBy(asc(stagedBlobs.expires_at));
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.all();
    return rows.map((row: Row) => logical(row, tenantId));
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
