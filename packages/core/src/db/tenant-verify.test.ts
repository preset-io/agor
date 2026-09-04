/**
 * Fast unit coverage for the verification SCOPE contract — how `verifyTenant`
 * decides which categories are in scope and folds them into the overall match.
 * The database and filesystem re-derivation are mocked so these tests exercise
 * the scope/match logic (finding: `--database-only` must not spuriously mismatch
 * a full archive) without a live database. The real end-to-end paths run in
 * `tenant-portability.postgres.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import type { TenantArchiveManifest } from './tenant-archive';
import type { TenantFilesystemEntry } from './tenant-filesystem';

const identity = { schemaVersion: '0001_test', fingerprint: 'f'.repeat(64) };

vi.mock('./tenant-archive', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tenant-archive')>();
  return {
    ...original,
    readManifest: vi.fn(),
    verifyArchiveIntegrity: vi.fn(async () => ({
      ok: true,
      checkedTables: 1,
      checkedFiles: 0,
      problems: [] as string[],
      problemCount: 0,
    })),
    assertManifestTablesMatchCatalog: vi.fn(() => {}),
  };
});

vi.mock('./tenant-catalog', () => ({
  resolveTenantDatabaseIdentity: vi.fn(async () => ({
    dialect: 'postgresql',
    schemaVersion: identity.schemaVersion,
    migrations: ['0001_test'],
    tenantTables: ['sessions'],
    nonPortableTenantTables: [
      'executor_session_token_authorities',
      'mcp_oauth_client_registrations',
      'mcp_oauth_pending_flows',
      'user_mcp_oauth_tokens',
    ],
    presentImperativeTables: [],
    fingerprint: identity.fingerprint,
  })),
}));

vi.mock('./tenant-database-io', () => ({
  snapshotTenantTableHashes: vi.fn(async () => [
    { name: 'sessions', rowCount: 1, sha256: 'a'.repeat(64) },
  ]),
}));

vi.mock('./tenant-scope', () => ({
  runWithTenantDatabaseScope: vi.fn(
    async (db: Database, _tenantId: string, fn: (s: Database) => unknown) => fn(db)
  ),
}));

const walkEntries = vi.fn<() => TenantFilesystemEntry[]>(() => []);
vi.mock('./tenant-filesystem', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tenant-filesystem')>();
  return {
    ...original,
    walkTenantFilesystemTree: vi.fn(async () => ({
      entries: walkEntries(),
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    })),
  };
});

import { readManifest } from './tenant-archive';
import { verifyTenant } from './tenant-verify';

const db = {} as Database;

/** A manifest whose database portion always matches the mocked live snapshot. */
function manifest(options: {
  includeFilesystem: boolean;
  entries?: TenantFilesystemEntry[];
}): TenantArchiveManifest {
  return {
    manifestVersion: 1,
    operationId: 'op',
    tenantId: 'acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    database: {
      identity: {
        dialect: 'postgresql',
        schemaVersion: identity.schemaVersion,
        migrations: ['0001_test'],
        tenantTables: ['sessions'],
        nonPortableTenantTables: [
          'executor_session_token_authorities',
          'mcp_oauth_client_registrations',
          'mcp_oauth_pending_flows',
          'user_mcp_oauth_tokens',
        ],
        presentImperativeTables: [],
        fingerprint: identity.fingerprint,
      },
      tables: [{ name: 'sessions', rowCount: 1, sha256: 'a'.repeat(64), bytes: 10 }],
    },
    filesystem: {
      included: options.includeFilesystem,
      entries: options.entries ?? [],
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    },
    contentFingerprint: 'c'.repeat(64),
  };
}

describe('verifyTenant scope contract', () => {
  it('database-only matches a full archive without a filesystem root', async () => {
    vi.mocked(readManifest).mockResolvedValueOnce(manifest({ includeFilesystem: true }));
    const result = await verifyTenant(db, { archivePath: '/x', scope: 'database' });
    expect(result.scope).toBe('database');
    expect(result.match).toBe(true);
    expect(result.database.matched).toBe(true);
    // Filesystem was intentionally skipped, not failed.
    expect(result.filesystem.requested).toBe(false);
    expect(result.filesystem.checked).toBe(false);
  });

  it('full scope matches when the filesystem root is supplied and agrees', async () => {
    vi.mocked(readManifest).mockResolvedValueOnce(manifest({ includeFilesystem: true }));
    walkEntries.mockReturnValueOnce([]);
    const result = await verifyTenant(db, {
      archivePath: '/x',
      scope: 'full',
      filesystemRoot: '/fs',
    });
    expect(result.match).toBe(true);
    expect(result.filesystem.requested).toBe(true);
    expect(result.filesystem.checked).toBe(true);
    expect(result.filesystem.matched).toBe(true);
  });

  it('full scope is fail-closed when a required filesystem cannot be checked', async () => {
    vi.mocked(readManifest).mockResolvedValueOnce(manifest({ includeFilesystem: true }));
    // Default scope is full; no filesystemRoot supplied for a filesystem archive.
    const result = await verifyTenant(db, { archivePath: '/x' });
    expect(result.scope).toBe('full');
    expect(result.database.matched).toBe(true);
    expect(result.filesystem.requested).toBe(true);
    expect(result.filesystem.checked).toBe(false);
    // The database matched, but the required filesystem could not be verified.
    expect(result.match).toBe(false);
  });

  it('full scope reports a filesystem mismatch', async () => {
    const entry: TenantFilesystemEntry = {
      type: 'file',
      path: 'repos/a.txt',
      mode: 0o644,
      size: 5,
      sha256: 'b'.repeat(64),
    };
    vi.mocked(readManifest).mockResolvedValueOnce(
      manifest({ includeFilesystem: true, entries: [entry] })
    );
    walkEntries.mockReturnValueOnce([]); // live tree missing the archived file
    const result = await verifyTenant(db, {
      archivePath: '/x',
      scope: 'full',
      filesystemRoot: '/fs',
    });
    expect(result.match).toBe(false);
    expect(result.filesystem.requested).toBe(true);
    expect(result.filesystem.checked).toBe(true);
    expect(result.filesystem.matched).toBe(false);
    expect(result.filesystem.mismatchCount).toBe(1);
  });

  it('a database-only archive is fully matched under full scope', async () => {
    vi.mocked(readManifest).mockResolvedValueOnce(manifest({ includeFilesystem: false }));
    const result = await verifyTenant(db, { archivePath: '/x', scope: 'full' });
    expect(result.match).toBe(true);
    expect(result.filesystem.requested).toBe(false);
    expect(result.filesystem.checked).toBe(false);
  });
});
