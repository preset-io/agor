import type {
  BranchID,
  SessionID,
  TenantID,
  Upload,
  UploadMetadata,
  UploadOwner,
  UploadRef,
  UserID,
} from '@agor/core/types';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { Database, SystemDatabase } from '../client';
import { deleteFrom, insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { type UploadRow, uploads } from '../schema';
import { RepositoryError } from './base';

function logical(row: UploadRow, tenantId: TenantID): Upload {
  return {
    ref: row.upload_ref as UploadRef,
    tenantId,
    createdBy: row.created_by as UserID,
    sessionId: row.session_id as SessionID,
    branchId: row.branch_id as BranchID,
    originalName: row.original_name,
    displayName: row.display_name,
    mimeType: row.content_type,
    size: row.size_bytes,
    checksum: row.checksum,
    status: row.status,
    provenance: row.provenance,
    homeSegment: row.storage_key,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

/** Tenant-explicit repository for upload metadata. It never returns storage keys. */
export class UploadRepository {
  constructor(private readonly db: Database) {}

  async create(
    owner: UploadOwner,
    metadata: UploadMetadata,
    homeSegment?: string
  ): Promise<Upload> {
    await insert(this.db, uploads)
      .values({
        upload_ref: metadata.ref,
        created_by: owner.createdBy,
        session_id: owner.sessionId,
        branch_id: owner.branchId,
        // Persisted home segment; rebuilds the physical key stably on later ops.
        storage_key: homeSegment ?? metadata.ref,
        original_name: metadata.name,
        display_name: metadata.name,
        content_type: metadata.mimeType,
        size_bytes: metadata.size,
        checksum: null,
        status: 'active',
        provenance: metadata.provenance,
        created_at: new Date(metadata.createdAt),
        expires_at: metadata.expiresAt ? new Date(metadata.expiresAt) : null,
      })
      .run();
    const created = await this.findOwned(owner.tenantId, metadata.ref);
    if (!created) throw new Error('Failed to persist upload metadata');
    return created;
  }

  async findOwned(tenantId: TenantID, ref: UploadRef): Promise<Upload | null> {
    const row = await select(this.db).from(uploads).where(eq(uploads.upload_ref, ref)).one();
    return row ? logical(row, tenantId) : null;
  }

  async listByUploader(tenantId: TenantID, userId: UserID): Promise<Upload[]> {
    const rows = await select(this.db)
      .from(uploads)
      .where(eq(uploads.created_by, userId))
      .orderBy(asc(uploads.created_at))
      .all();
    return rows.map((row: UploadRow) => logical(row, tenantId));
  }

  async rename(tenantId: TenantID, ref: UploadRef, displayName: string): Promise<Upload | null> {
    await update(this.db, uploads)
      .set({ display_name: displayName })
      .where(eq(uploads.upload_ref, ref))
      .run();
    return this.findOwned(tenantId, ref);
  }

  async remove(tenantId: TenantID, ref: UploadRef): Promise<void> {
    await deleteFrom(this.db, uploads).where(eq(uploads.upload_ref, ref)).run();
  }

  async findExpired(tenantId: TenantID, now: Date, limit?: number): Promise<Upload[]> {
    let query = select(this.db)
      .from(uploads)
      .where(and(isNotNull(uploads.expires_at), lt(uploads.expires_at, now)))
      .orderBy(asc(uploads.expires_at));
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.all();
    return rows.map((row: UploadRow) => logical(row, tenantId));
  }
}

/** Narrow system-scope discovery for deployment-local upload maintenance. */
export class UploadMaintenanceDiscoveryRepository {
  constructor(private readonly db: SystemDatabase) {}

  async findExpiredTenantIds(now: Date, limit: number): Promise<TenantID[]> {
    const tenantColumn = (uploads as unknown as { tenant_id?: unknown }).tenant_id;
    if (!isPostgresDatabase(this.db) || !tenantColumn) {
      throw new RepositoryError('Cross-tenant upload maintenance requires PostgreSQL metadata');
    }
    const rows = await select(this.db, { tenant_id: tenantColumn })
      .from(uploads)
      .where(and(isNotNull(uploads.expires_at), lt(uploads.expires_at, now)))
      .groupBy(tenantColumn)
      .orderBy(tenantColumn)
      .limit(limit)
      .all();
    return (rows as Array<{ tenant_id?: unknown }>).map((row) => {
      if (typeof row.tenant_id !== 'string' || !row.tenant_id) {
        throw new RepositoryError('Upload maintenance discovered a row without tenant identity');
      }
      return row.tenant_id as TenantID;
    });
  }
}
