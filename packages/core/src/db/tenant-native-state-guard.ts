import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import type { TenantArchiveManifest } from './tenant-archive';
import { readTableJsonl } from './tenant-archive';
import { TenantNativeStateHandoffRequiredError } from './tenant-deletion';
import { hasOpenCodeNativeStateFilesystemEntries } from './tenant-filesystem';
import { runWithTenantDatabaseScope } from './tenant-scope';

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) return result[0] as Record<string, unknown> | undefined;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

function truthyDb(value: unknown): boolean {
  return value === true || value === 't' || value === 1 || value === '1';
}

/**
 * Reject an export/import/verify when a tenant has a native checkpoint grant,
 * pointer, or immutable store identity. The write gate alone is not a process
 * drain and cannot make those physical addresses portable.
 */
export async function assertTenantNativeStateHandoffClear(
  db: Database,
  tenantId: string
): Promise<void> {
  // SQLite is a supported source for ordinary tenant operations. It has no
  // RLS policy or tenant column on Sessions, but its single-tenant `default`
  // home can still be checked. Other SQLite tenant identities are uncertain
  // and remain fail-closed.
  const postgres = isPostgresDatabase(db);
  if (!postgres && tenantId !== 'default') throw new TenantNativeStateHandoffRequiredError();
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const sessionState = postgres
      ? sql`data ? 'sdk_native_state' OR data ? 'sdk_native_state_store_id'`
      : sql`json_type(data, '$.sdk_native_state') IS NOT NULL
          OR json_type(data, '$.sdk_native_state_store_id') IS NOT NULL`;
    const sessionTenantFilter = postgres ? sql`tenant_id = ${tenantId} AND` : sql``;
    const row = firstRow(
      await executeRaw(
        scoped,
        sql`
      SELECT
        EXISTS (SELECT 1 FROM opencode_checkpoint_attempts WHERE tenant_id = ${postgres ? tenantId : 'default'}) AS has_attempts,
        EXISTS (
          SELECT 1 FROM sessions
          WHERE ${sessionTenantFilter} (${sessionState})
        ) AS has_session_state
    `
      )
    );
    if (truthyDb(row?.has_attempts) || truthyDb(row?.has_session_state)) {
      throw new TenantNativeStateHandoffRequiredError();
    }
  });
}

/** Refuse archives that try to omit native state from the portable manifest. */
export async function assertArchiveNativeStateAbsent(
  archivePath: string,
  manifest: TenantArchiveManifest
): Promise<void> {
  if (hasOpenCodeNativeStateFilesystemEntries(manifest.filesystem.entries)) {
    throw new TenantNativeStateHandoffRequiredError();
  }
  if (manifest.database.tables.some((table) => table.name === 'opencode_checkpoint_attempts')) {
    throw new TenantNativeStateHandoffRequiredError();
  }
  const sessions = manifest.database.tables.find((table) => table.name === 'sessions');
  if (!sessions || sessions.rowCount === 0) return;
  const text = await readTableJsonl(archivePath, sessions.name);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // Integrity/row-shape validation reports malformed JSON itself.
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const data = (row as { data?: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      if (
        Object.hasOwn(record, 'sdk_native_state') ||
        Object.hasOwn(record, 'sdk_native_state_store_id')
      ) {
        throw new TenantNativeStateHandoffRequiredError();
      }
    }
  }
}
