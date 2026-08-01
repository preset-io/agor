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
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type UploadRow, uploads } from '../schema';

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
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

/** Tenant-explicit repository for upload metadata. It never returns storage keys. */
export class UploadRepository {
  constructor(private readonly db: Database) {}

  async create(owner: UploadOwner, metadata: UploadMetadata): Promise<Upload> {
    await insert(this.db, uploads)
      .values({
        upload_ref: metadata.ref,
        created_by: owner.createdBy,
        session_id: owner.sessionId,
        branch_id: owner.branchId,
        // The byte-store port currently uses UploadRef as its opaque internal
        // key. A Cloud adapter may translate this without exposing it.
        storage_key: metadata.ref,
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

  async findExpired(tenantId: TenantID, now: Date): Promise<Upload[]> {
    const rows = await select(this.db)
      .from(uploads)
      .where(and(isNotNull(uploads.expires_at), lt(uploads.expires_at, now)))
      .all();
    return rows.map((row: UploadRow) => logical(row, tenantId));
  }
}
