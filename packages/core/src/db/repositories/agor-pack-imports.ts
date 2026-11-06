import type {
  AgorPackDryRunTeammate,
  AgorPackImport,
  AgorPackImportStatus,
  AgorPackManifest,
  AgorPackTeammateProgress,
  AgorPackTeammateResult,
} from '@agor/core/types';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import { agorPackImports } from '../schema';

type Row = typeof agorPackImports.$inferSelect;

export interface AgorPackImportRecord extends AgorPackImport {
  owner_user_id: string;
  staging_ref: string | null;
  progress: Record<string, AgorPackTeammateProgress>;
  claim_token: string | null;
  claimed_at: string | null;
}

/** The apply claim was taken over (it went stale) or released; stop writing. */
export class AgorPackImportClaimLostError extends Error {
  constructor() {
    super('This import is being applied elsewhere');
    this.name = 'AgorPackImportClaimLostError';
  }
}

type ReceiptPatch = Partial<{
  staging_ref: string | null;
  status: AgorPackImportStatus;
  dry_run: AgorPackDryRunTeammate[];
  results: AgorPackTeammateResult[];
  progress: Record<string, AgorPackTeammateProgress>;
  error: string | null;
  applied_at: Date | null;
}>;

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
    progress: (row.progress as Record<string, AgorPackTeammateProgress> | null) ?? {},
    claim_token: row.claim_token ?? null,
    claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    error: row.error ?? null,
    created_at: new Date(row.created_at).toISOString(),
    applied_at: row.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

/** `.agor` import receipts: idempotency key, dry-run cache, and remap. */
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

  async update(importId: string, patch: ReceiptPatch): Promise<AgorPackImportRecord> {
    const row = await update(this.db, agorPackImports)
      .set({ ...patch, updated_at: new Date() })
      .where(eq(agorPackImports.import_id, importId))
      .returning()
      .one();
    return toRecord(row);
  }

  /**
   * Take the apply claim with one conditional update, so exactly one worker
   * (in any process) applies an import at a time. A claim whose holder has not
   * written since `staleBefore` is presumed dead and can be taken over.
   */
  async claim(
    importId: string,
    ownerUserId: string,
    token: string,
    staleBefore: Date,
    patch: ReceiptPatch = {}
  ): Promise<AgorPackImportRecord | null> {
    const now = new Date();
    const row = await update(this.db, agorPackImports)
      .set({ ...patch, claim_token: token, claimed_at: now, updated_at: now })
      .where(
        and(
          eq(agorPackImports.import_id, importId),
          eq(agorPackImports.owner_user_id, ownerUserId),
          or(isNull(agorPackImports.claim_token), lt(agorPackImports.claimed_at, staleBefore))
        )
      )
      .returning()
      .one();
    return row ? toRecord(row) : null;
  }

  /**
   * Fence: refresh the claim only if `token` still holds it. Run it first in
   * the same transaction as the writes it guards; on PostgreSQL the row lock
   * it takes also holds off a takeover until that transaction commits.
   */
  async touchClaim(importId: string, token: string): Promise<boolean> {
    const row = await update(this.db, agorPackImports)
      .set({ claimed_at: new Date() })
      .where(and(eq(agorPackImports.import_id, importId), eq(agorPackImports.claim_token, token)))
      .returning()
      .one();
    return Boolean(row);
  }

  /**
   * Imports left `applying` by a dead worker (claim older than `staleBefore`)
   * become `failed` with `error`, so they read as resumable and stop counting
   * as in use. The stale claim itself stays: any later claim may take it over.
   */
  async failStale(staleBefore: Date, error: string): Promise<void> {
    await update(this.db, agorPackImports)
      .set({ status: 'failed', error, updated_at: new Date() })
      .where(
        and(eq(agorPackImports.status, 'applying'), lt(agorPackImports.claimed_at, staleBefore))
      )
      .run();
  }

  /** Write as the claim holder (refreshing the claim); throws once it was lost. */
  async updateClaimed(
    importId: string,
    token: string,
    patch: ReceiptPatch & { release?: boolean }
  ): Promise<AgorPackImportRecord> {
    const { release, ...fields } = patch;
    const now = new Date();
    const row = await update(this.db, agorPackImports)
      .set({
        ...fields,
        updated_at: now,
        ...(release ? { claim_token: null, claimed_at: null } : { claimed_at: now }),
      })
      .where(and(eq(agorPackImports.import_id, importId), eq(agorPackImports.claim_token, token)))
      .returning()
      .one();
    if (!row) throw new AgorPackImportClaimLostError();
    return toRecord(row);
  }
}
