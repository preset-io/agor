/**
 * Unit coverage for the archive/manifest format — canonical JSON determinism,
 * content-fingerprint stability, manifest validation (malformed rejection), and
 * payload integrity checking. No database required.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertManifestShape,
  canonicalJson,
  computeContentFingerprint,
  databaseDir,
  MalformedArchiveError,
  readManifest,
  serializeManifest,
  sha256Hex,
  TENANT_ARCHIVE_MANIFEST_VERSION,
  type TenantArchiveManifest,
  tableJsonlPath,
  verifyArchiveIntegrity,
  writeManifest,
} from './tenant-archive';
import type { TenantDatabaseIdentity } from './tenant-catalog';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-archive-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const identity: TenantDatabaseIdentity = {
  dialect: 'postgresql',
  schemaVersion: '0072_example',
  migrations: ['0000_a', '0001_b', '0072_example'],
  tenantTables: ['boards', 'sessions'],
  presentImperativeTables: [],
  fingerprint: 'fake-identity-fingerprint',
};

function makeManifest(tables: TenantArchiveManifest['database']['tables']): TenantArchiveManifest {
  const base = {
    manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
    tenantId: 'acme',
    database: { identity, tables },
    filesystem: { included: false, entries: [], skippedSpecialCount: 0, unsafeSymlinkCount: 0 },
  };
  return {
    ...base,
    operationId: 'op-123',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentFingerprint: computeContentFingerprint(base),
  };
}

describe('canonicalJson', () => {
  it('is stable regardless of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('computeContentFingerprint', () => {
  it('excludes wall-clock metadata (two exports of same data match)', () => {
    const a = makeManifest([{ name: 'sessions', rowCount: 1, sha256: 'h', bytes: 10 }]);
    const b = { ...a, operationId: 'different', createdAt: '2030-12-31T23:59:59.000Z' };
    expect(a.contentFingerprint).toBe(computeContentFingerprint(b));
  });

  it('changes when table hashes change', () => {
    const a = makeManifest([{ name: 'sessions', rowCount: 1, sha256: 'h1', bytes: 10 }]);
    const b = makeManifest([{ name: 'sessions', rowCount: 1, sha256: 'h2', bytes: 10 }]);
    expect(a.contentFingerprint).not.toBe(b.contentFingerprint);
  });
});

describe('manifest validation', () => {
  it('round-trips a written manifest', async () => {
    const manifest = makeManifest([
      { name: 'sessions', rowCount: 0, sha256: sha256Hex(''), bytes: 0 },
    ]);
    await writeManifest(scratch, manifest);
    const read = await readManifest(scratch);
    expect(read.tenantId).toBe('acme');
    expect(read.contentFingerprint).toBe(manifest.contentFingerprint);
  });

  it('rejects an unknown manifest version', () => {
    expect(() => assertManifestShape({ manifestVersion: 999 })).toThrow(MalformedArchiveError);
  });

  it('rejects a tampered contentFingerprint', () => {
    const manifest = makeManifest([{ name: 'sessions', rowCount: 1, sha256: 'h', bytes: 10 }]);
    const tampered = { ...manifest, contentFingerprint: 'wrong' };
    expect(() => assertManifestShape(tampered)).toThrow(/contentFingerprint/);
  });

  it('rejects non-object input and missing fields', () => {
    expect(() => assertManifestShape(null)).toThrow(MalformedArchiveError);
    expect(() => assertManifestShape('x')).toThrow(MalformedArchiveError);
  });

  it('rejects an unsafe table name for the jsonl path', () => {
    expect(() => tableJsonlPath(scratch, '../evil')).toThrow(MalformedArchiveError);
    expect(() => tableJsonlPath(scratch, 'good_table')).not.toThrow();
  });

  it('serialises with a trailing newline', () => {
    const manifest = makeManifest([]);
    expect(serializeManifest(manifest).endsWith('}\n')).toBe(true);
  });
});

describe('verifyArchiveIntegrity', () => {
  it('passes when files match and fails when hashes differ', async () => {
    const jsonl = '{"a":1}\n';
    const bytes = Buffer.from(jsonl, 'utf8');
    const manifest = makeManifest([
      { name: 'sessions', rowCount: 1, sha256: sha256Hex(bytes), bytes: bytes.byteLength },
    ]);
    await mkdir(databaseDir(scratch), { recursive: true });
    await writeFile(tableJsonlPath(scratch, 'sessions'), bytes);
    await writeManifest(scratch, manifest);

    const ok = await verifyArchiveIntegrity(scratch, manifest);
    expect(ok.ok).toBe(true);
    expect(ok.checkedTables).toBe(1);

    // Corrupt the payload.
    await writeFile(tableJsonlPath(scratch, 'sessions'), Buffer.from('{"a":2}\n'));
    const bad = await verifyArchiveIntegrity(scratch, manifest);
    expect(bad.ok).toBe(false);
    expect(bad.problemCount).toBeGreaterThan(0);
  });

  it('reports a missing database file', async () => {
    const manifest = makeManifest([{ name: 'sessions', rowCount: 1, sha256: 'h', bytes: 5 }]);
    await mkdir(databaseDir(scratch), { recursive: true });
    const result = await verifyArchiveIntegrity(scratch, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/missing database file/);
  });
});
