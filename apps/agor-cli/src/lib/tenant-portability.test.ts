import type {
  TenantDeleteFilesPendingResult,
  TenantDeleteResult,
  TenantExportResult,
  TenantImportResult,
  TenantInspectionResult,
  TenantVerificationResult,
} from '@agor/core/tenant-portability';
import { describe, expect, it } from 'vitest';
import {
  formatPortabilityError,
  serializeStdoutJson,
  TENANT_PORTABILITY_ERROR_MARKER,
  TENANT_PORTABILITY_ERROR_VERSION,
} from './tenant-portability';

describe('formatPortabilityError', () => {
  it('retains only allowlisted structural metadata from a wrapped PostgreSQL failure', () => {
    const distinctive = 'tenant-secret-43e2c831';
    const postgresCause = Object.assign(new Error(`PG detail leaked ${distinctive}`), {
      code: '23503',
      constraint: 'branches_board_id_boards_board_id_fk',
      table: 'branches',
      column: 'board_id',
      detail: `Key contains ${distinctive}`,
      hint: `Try password=${distinctive}`,
      query: `insert into branches values ('${distinctive}')`,
      parameters: [distinctive],
    });
    const wrapped = new Error(`Failed query with params ${distinctive}`, {
      cause: postgresCause,
    });

    const formatted = formatPortabilityError(wrapped);
    expect(JSON.parse(formatted)).toEqual({
      marker: TENANT_PORTABILITY_ERROR_MARKER,
      version: TENANT_PORTABILITY_ERROR_VERSION,
      category: 'database_constraint',
      sqlstate: '23503',
      constraint: 'branches_board_id_boards_board_id_fk',
      table: 'branches',
      column: 'board_id',
    });
    expect(formatted).not.toContain(distinctive);
    expect(formatted).not.toContain('insert into');
    expect(formatted).not.toContain('params');
    expect(formatted).not.toContain('detail');
    expect(formatted).not.toContain('password');
  });

  it('drops unvalidated identifiers and arbitrary cause strings', () => {
    const formatted = formatPortabilityError(
      Object.assign(new Error('postgresql://operator:secret@example.test/agor'), {
        cause: {
          code: '23503',
          constraint: 'constraint; select secret',
          table: 't'.repeat(64),
          column: '../tenant-path',
          detail: '/srv/tenants/distinctive-tenant',
        },
      })
    );

    expect(JSON.parse(formatted)).toEqual({
      marker: TENANT_PORTABILITY_ERROR_MARKER,
      version: TENANT_PORTABILITY_ERROR_VERSION,
      category: 'database_constraint',
      sqlstate: '23503',
    });
    expect(formatted).not.toContain('secret');
    expect(formatted).not.toContain('tenant-path');
  });

  it('maps known failures to stable categories without reading their messages', () => {
    const formatted = formatPortabilityError({
      name: 'TenantFilesystemDeletionPendingError',
      message: '/srv/tenants/distinctive-tenant: permission denied',
      cause: { code: 'EPERM', path: '/srv/tenants/distinctive-tenant' },
    });

    expect(JSON.parse(formatted)).toEqual({
      marker: TENANT_PORTABILITY_ERROR_MARKER,
      version: TENANT_PORTABILITY_ERROR_VERSION,
      category: 'filesystem_deletion_pending',
    });
    expect(formatted).not.toContain('/srv/tenants');
  });
});

describe('tenant command stdout contracts', () => {
  const expectContract = (value: unknown): void => {
    const serialized = serializeStdoutJson(value);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(value);
  };

  it('preserves the inspect result shape', () => {
    expectContract({
      tenantId: 'tenant-a',
      database: {
        dialect: 'postgresql',
        schemaVersion: '0069_example',
        migrationCount: 70,
        tenantTableCount: 1,
        tables: [{ name: 'boards', rowCount: 1 }],
        derivedTables: [],
        totalRows: 1,
        identityFingerprint: 'inspection-fingerprint',
      },
      filesystem: { inspected: false, inventory: null },
    } satisfies TenantInspectionResult);
  });

  it('preserves the export result shape', () => {
    expectContract({
      operationId: 'operation-a',
      tenantId: 'tenant-a',
      manifestVersion: 1,
      schemaVersion: '0069_example',
      contentFingerprint: 'export-fingerprint',
      database: { tableCount: 1, totalRows: 1 },
      filesystem: { included: true, fileCount: 2, totalBytes: 12 },
      archivePath: '/runtime/archive',
    } satisfies TenantExportResult);
  });

  it('preserves the import result shape', () => {
    expectContract({
      operationId: 'operation-a',
      tenantId: 'tenant-a',
      contentFingerprint: 'import-fingerprint',
      alreadyApplied: false,
      database: { restored: true, tableCount: 1, totalRows: 1 },
      filesystem: { restored: true, fileCount: 2 },
    } satisfies TenantImportResult);
  });

  it('preserves the verify result shape', () => {
    expectContract({
      tenantId: 'tenant-a',
      scope: 'full',
      match: true,
      contentFingerprint: 'verify-fingerprint',
      archiveIntegrity: { ok: true, problemCount: 0, problems: [] },
      identity: {
        matched: true,
        liveSchemaVersion: '0069_example',
        archiveSchemaVersion: '0069_example',
      },
      database: {
        checked: true,
        matched: true,
        tableCount: 1,
        mismatchCount: 0,
        mismatchedTables: [],
      },
      filesystem: {
        requested: true,
        checked: true,
        matched: true,
        mismatchCount: 0,
        mismatchedPaths: [],
      },
    } satisfies TenantVerificationResult);
  });

  it('preserves the complete combined deletion envelope', () => {
    expectContract({
      tenantId: 'tenant-a',
      tenantDataDeleted: true,
      schemaVersion: '0069_example',
      rowCounts: { boards: 1 },
      tenantDeletionComplete: true,
      databaseCommitted: true,
      filesPending: false,
      filesystem: {
        requested: true,
        isolationEnabled: true,
        present: true,
        deleted: true,
        verifiedAbsent: true,
        status: 'deleted',
      },
    } satisfies TenantDeleteResult);
  });

  it('preserves the DB-committed/files-pending deletion envelope', () => {
    expectContract({
      tenantId: 'tenant-a',
      tenantDataDeleted: true,
      schemaVersion: '0069_example',
      rowCounts: { boards: 1 },
      tenantDeletionComplete: false,
      databaseCommitted: true,
      filesPending: true,
      filesystem: {
        requested: true,
        isolationEnabled: true,
        present: null,
        deleted: false,
        verifiedAbsent: false,
        status: 'pending',
      },
    } satisfies TenantDeleteFilesPendingResult);
  });
});
