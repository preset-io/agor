import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from './client';

vi.mock('./tenant-deletion', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tenant-deletion')>();
  return { ...original, deleteTenantData: vi.fn(original.deleteTenantData) };
});

vi.mock('./tenant-filesystem', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tenant-filesystem')>();
  return {
    ...original,
    deleteTenantFilesystemTree: vi.fn(original.deleteTenantFilesystemTree),
  };
});

import {
  deleteTenant,
  type TenantDeleteFilesPendingResult,
  TenantFilesystemDeletionPendingError,
} from './tenant-delete';
import { deleteTenantData, type TenantDeletionResult } from './tenant-deletion';
import { deleteTenantFilesystemTree } from './tenant-filesystem';

const db = {} as Database;
let scratch: string;

function databaseResult(rowCount: number): TenantDeletionResult {
  return {
    tenantDataDeleted: true,
    schemaVersion: '0042_test',
    rowCounts: { sessions: rowCount },
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-delete-'));
  vi.mocked(deleteTenantData).mockReset();
  vi.mocked(deleteTenantFilesystemTree).mockClear();
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('deleteTenant combined contract', () => {
  it('deletes and proves both database data and the configured tenant filesystem', async () => {
    const base = join(scratch, 'tenants');
    const root = join(base, 'tenant-a');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'data.txt'), 'tenant data');
    vi.mocked(deleteTenantData).mockResolvedValueOnce(databaseResult(3));

    const result = await deleteTenant(db, 'tenant-a', { filesystem: { root, base } });

    expect(result).toMatchObject({
      tenantId: 'tenant-a',
      tenantDataDeleted: true,
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
    });
    await expect(stat(root)).rejects.toBeTruthy();
  });

  it('reports DB-committed/files-pending and completes on an idempotent retry', async () => {
    const base = join(scratch, 'tenants');
    const root = join(base, 'tenant-a');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'data.txt'), 'tenant data');
    vi.mocked(deleteTenantData)
      .mockResolvedValueOnce(databaseResult(3))
      .mockResolvedValueOnce(databaseResult(0));
    const actualFilesystem =
      await vi.importActual<typeof import('./tenant-filesystem')>('./tenant-filesystem');
    vi.mocked(deleteTenantFilesystemTree).mockImplementationOnce(async (tenantRoot, baseRoot) => {
      await actualFilesystem.deleteTenantFilesystemTree(tenantRoot, baseRoot);
      throw new Error('simulated filesystem tail failure after removal');
    });

    let pending: TenantDeleteFilesPendingResult | undefined;
    try {
      await deleteTenant(db, 'tenant-a', {
        filesystem: { root, base },
        assertGateGeneration: 'gate-generation-1',
      });
      throw new Error('expected filesystem tail failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantFilesystemDeletionPendingError);
      pending = (error as TenantFilesystemDeletionPendingError).result;
    }
    expect(pending).toMatchObject({
      tenantDataDeleted: true,
      tenantDeletionComplete: false,
      databaseCommitted: true,
      filesPending: true,
      filesystem: {
        requested: true,
        isolationEnabled: true,
        present: true,
        deleted: false,
        verifiedAbsent: false,
        status: 'pending',
      },
    });
    await expect(stat(root)).rejects.toBeTruthy();

    const retried = await deleteTenant(db, 'tenant-a', { filesystem: { root, base } });
    expect(retried).toMatchObject({
      tenantDataDeleted: true,
      rowCounts: { sessions: 0 },
      tenantDeletionComplete: true,
      databaseCommitted: true,
      filesPending: false,
      filesystem: {
        deleted: false,
        verifiedAbsent: true,
        status: 'already-absent',
      },
    });
    expect(deleteTenantData).toHaveBeenCalledTimes(2);
    expect(deleteTenantData).toHaveBeenNthCalledWith(
      1,
      db,
      'tenant-a',
      expect.objectContaining({ assertGateGeneration: 'gate-generation-1' })
    );
    expect(deleteTenantData).toHaveBeenNthCalledWith(2, db, 'tenant-a', {
      dryRun: false,
    });
    await expect(stat(root)).rejects.toBeTruthy();
  });
});
