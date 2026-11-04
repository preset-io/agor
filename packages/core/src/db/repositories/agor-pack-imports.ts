import type {
  AgorPackDryRunTeammate,
  AgorPackImport,
  AgorPackImportStatus,
  AgorPackManifest,
  AgorPackTeammateResult,
} from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import { agorPackImports } from '../schema';

type Row = typeof agorPackImports.$inferSelect;

export interface AgorPackImportRecord extends AgorPackImport {
  owner_user_id: string;
  staging_ref: string | null;
}

function toRecord(row: Row): AgorPackImportRecord {
  return {
    import_id: row.import_id,
    owner_user_id: row.owner_user_id,
    staging_ref: row.staging_ref ?? null,
    status: row.status as AgorPackImportStatus,
    content_sha256: row.content_sha256,
    manifest: row.manifest as AgorPackManifest,
    dry_run: (row.dry_run as AgorPackDryRunTeammate[] | null) ?? [],
    results: (row.results as AgorPackTeammateResult[] | null) ?? [],
    error: row.error ?? null,
    created_at: new Date(row.created_at).toISOString(),
    applied_at: row.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

/** `.agorpack` import receipts: idempotency key, dry-run cache, and remap. */
export class AgorPackImportRepository {
  constructor(private readonly db: Database) {}

  async findByContent(
    ownerUserId: string,
    contentSha256: string
  ): Promise<AgorPackImportRecord | null> {
    const row = await select(this.db)
      .from(agorPackImports)
      .where(
        and(
          eq(agorPackImports.owner_user_id, ownerUserId),
          eq(agorPackImports.content_sha256, contentSha256)
        )
      )
      .one();
    return row ? toRecord(row) : null;
  }

  async findById(importId: string): Promise<AgorPackImportRecord | null> {
    const row = await select(this.db)
      .from(agorPackImports)
      .where(eq(agorPackImports.import_id, importId))
      .one();
    return row ? toRecord(row) : null;
  }

  async create(input: {
    owner_user_id: string;
    content_sha256: string;
    staging_ref: string;
    manifest: AgorPackManifest;
    dry_run: AgorPackDryRunTeammate[];
  }): Promise<AgorPackImportRecord> {
    const now = new Date();
    const row = await insert(this.db, agorPackImports)
      .values({
        import_id: generateId(),
        owner_user_id: input.owner_user_id,
        content_sha256: input.content_sha256,
        staging_ref: input.staging_ref,
        status: 'staged',
        manifest: input.manifest,
        dry_run: input.dry_run,
        results: [],
        error: null,
        created_at: now,
        updated_at: now,
        applied_at: null,
      })
      .returning()
      .one();
    return toRecord(row);
  }

  async update(
    importId: string,
    patch: Partial<{
      staging_ref: string | null;
      status: AgorPackImportStatus;
      dry_run: AgorPackDryRunTeammate[];
      results: AgorPackTeammateResult[];
      error: string | null;
      applied_at: Date | null;
    }>
  ): Promise<AgorPackImportRecord> {
    const row = await update(this.db, agorPackImports)
      .set({ ...patch, updated_at: new Date() })
      .where(eq(agorPackImports.import_id, importId))
      .returning()
      .one();
    return toRecord(row);
  }
}
