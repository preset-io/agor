/**
 * SQLite-safe ordering coverage for `importTenant`: a crafted, self-consistent
 * archive whose symlink target escapes the tenant root must be rejected BEFORE
 * any database access — otherwise the CLI's "rejected before any data was
 * modified" hint would be a lie once the database has been mutated. We prove the
 * ordering without a live database by passing a `db` proxy that throws on ANY
 * access: if the escaping link is caught first, that proxy is never touched.
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client';
import {
  computeContentFingerprint,
  databaseDir,
  filesDir,
  sha256Hex,
  TENANT_ARCHIVE_MANIFEST_VERSION,
  type TenantArchiveManifest,
  writeManifest,
} from './tenant-archive';
import type { TenantDatabaseIdentity } from './tenant-catalog';
import { UnsafeArchivePathError } from './tenant-filesystem';
import { importTenant } from './tenant-import';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-import-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const identity: TenantDatabaseIdentity = {
  dialect: 'postgresql',
  schemaVersion: '0072_example',
  migrations: ['0000_a', '0072_example'],
  tenantTables: [],
  presentImperativeTables: [],
  fingerprint: sha256Hex('identity'),
};

/**
 * Write a self-consistent (correctly-fingerprinted) archive containing exactly
 * one symlink entry with the given stored target, and materialise a real symlink
 * in `files/` so integrity checking passes. Tables are empty, so nothing but the
 * symlink governs whether the import is rejected.
 */
async function writeArchiveWithSymlink(root: string, linkTarget: string): Promise<void> {
  const entryPath = 'sub/link';
  const base: Pick<
    TenantArchiveManifest,
    'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
  > = {
    manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
    tenantId: 'acme',
    database: { identity, tables: [] },
    filesystem: {
      included: true,
      entries: [{ path: entryPath, type: 'symlink', size: 0, linkTarget, mode: 0o777 }],
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    },
  };
  const manifest: TenantArchiveManifest = {
    ...base,
    operationId: 'op-craft',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentFingerprint: computeContentFingerprint(base),
  };
  await mkdir(databaseDir(root), { recursive: true });
  const linkOnDisk = join(filesDir(root), entryPath);
  await mkdir(dirname(linkOnDisk), { recursive: true });
  // A real symlink so lstat-based integrity classifies it as a symlink; the
  // target string is what the manifest declares (need not resolve on disk).
  await symlink(linkTarget, linkOnDisk);
  await writeManifest(root, manifest);
}

/** A `db` that fails the test loudly if importTenant touches it. */
function untouchableDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('database was accessed before the archive was fully validated');
      },
    }
  ) as unknown as Database;
}

describe('importTenant pre-mutation validation ordering', () => {
  it('rejects an escaping symlink target before any database access', async () => {
    await writeArchiveWithSymlink(scratch, '../../../../etc/passwd');
    await expect(importTenant(untouchableDb(), { archivePath: scratch })).rejects.toBeInstanceOf(
      UnsafeArchivePathError
    );
  });

  it('accepts an in-root symlink and only then reaches the database', async () => {
    // A link whose target stays in-root passes the pre-mutation check, so the
    // next step (resolving the live database identity) touches the proxy — the
    // error is the db-access sentinel, NOT a path rejection. This proves the
    // validator does not false-positive and that db access is strictly after it.
    await writeArchiveWithSymlink(scratch, 'real.txt');
    await expect(importTenant(untouchableDb(), { archivePath: scratch })).rejects.toThrow(
      /database was accessed/
    );
  });
});
