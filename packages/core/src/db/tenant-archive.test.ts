/**
 * Unit coverage for the archive/manifest format — canonical JSON determinism,
 * content-fingerprint stability, manifest validation (malformed rejection), and
 * payload integrity checking. No database required.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertManifestShape,
  assertManifestTablesMatchCatalog,
  canonicalJson,
  computeContentFingerprint,
  databaseDir,
  filesDir,
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

/** A syntactically valid SHA-256 hex digest for fixtures that need one. */
const HEX = sha256Hex('fixture');

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
  nonPortableTenantTables: [
    'executor_session_token_authorities',
    'mcp_oauth_client_registrations',
    'mcp_oauth_pending_flows',
    'user_mcp_oauth_tokens',
  ],
  presentImperativeTables: [],
  fingerprint: sha256Hex('identity'),
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

  it('rejects an operationId with a path separator or ".." (staging-path escape)', () => {
    // The content fingerprint excludes operationId, so a hostile id keeps the
    // manifest otherwise valid — the dedicated check is the only defense.
    const good = makeManifest([{ name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 }]);
    expect(() => assertManifestShape({ ...good, operationId: 'x/../../../victim' })).toThrow(
      MalformedArchiveError
    );
    expect(() => assertManifestShape({ ...good, operationId: 'a/b' })).toThrow(
      MalformedArchiveError
    );
    expect(() => assertManifestShape({ ...good, operationId: 'a\\b' })).toThrow(
      MalformedArchiveError
    );
    expect(() => assertManifestShape({ ...good, operationId: 'a..b' })).toThrow(
      MalformedArchiveError
    );
    // A plain UUID-like id is accepted.
    expect(() => assertManifestShape({ ...good, operationId: 'op-123' })).not.toThrow();
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
    const manifest = makeManifest([{ name: 'sessions', rowCount: 1, sha256: HEX, bytes: 5 }]);
    await mkdir(databaseDir(scratch), { recursive: true });
    const result = await verifyArchiveIntegrity(scratch, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/missing database file/);
  });

  it('records a file entry that has no content hash instead of skipping it', async () => {
    // A file present on disk but with no manifest sha256 must never pass silently.
    const base: Pick<
      TenantArchiveManifest,
      'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
    > = {
      manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
      tenantId: 'acme',
      database: { identity, tables: [] },
      filesystem: {
        included: true,
        entries: [{ path: 'f.txt', type: 'file', size: 3, mode: 0o644 }],
        skippedSpecialCount: 0,
        unsafeSymlinkCount: 0,
      },
    };
    const manifest: TenantArchiveManifest = {
      ...base,
      operationId: 'op-nohash',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentFingerprint: computeContentFingerprint(base),
    };
    await mkdir(filesDir(scratch), { recursive: true });
    await writeFile(join(filesDir(scratch), 'f.txt'), 'abc');
    const result = await verifyArchiveIntegrity(scratch, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/no content hash/);
  });

  it('confirms directory and symlink entries exist with the expected type', async () => {
    const base: Pick<
      TenantArchiveManifest,
      'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
    > = {
      manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
      tenantId: 'acme',
      database: { identity, tables: [] },
      filesystem: {
        included: true,
        entries: [
          { path: 'sub', type: 'directory', size: 0, mode: 0o755 },
          { path: 'sub/link', type: 'symlink', size: 0, linkTarget: 'x', mode: 0o777 },
        ],
        skippedSpecialCount: 0,
        unsafeSymlinkCount: 0,
      },
    };
    const manifest: TenantArchiveManifest = {
      ...base,
      operationId: 'op-fs',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentFingerprint: computeContentFingerprint(base),
    };

    // Nothing materialised yet: the directory and symlink entries are missing.
    const missing = await verifyArchiveIntegrity(scratch, manifest);
    expect(missing.ok).toBe(false);
    expect(missing.problems.join(' ')).toMatch(/missing archived (directory|symlink)/);

    // Materialise the directory and symlink and verify passes.
    const files = filesDir(scratch);
    await mkdir(join(files, 'sub'), { recursive: true });
    await symlink('x', join(files, 'sub', 'link'));
    const ok = await verifyArchiveIntegrity(scratch, manifest);
    expect(ok.ok).toBe(true);

    // A wrong type at an archived path is reported (symlink present where a
    // directory is expected).
    const wrongBase: Pick<
      TenantArchiveManifest,
      'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
    > = {
      ...base,
      filesystem: {
        included: true,
        entries: [{ path: 'sub/link', type: 'directory', size: 0, mode: 0o755 }],
        skippedSpecialCount: 0,
        unsafeSymlinkCount: 0,
      },
    };
    const wrong: TenantArchiveManifest = {
      ...wrongBase,
      operationId: 'op-fs2',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentFingerprint: computeContentFingerprint(wrongBase),
    };
    const mismatch = await verifyArchiveIntegrity(scratch, wrong);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.problems.join(' ')).toMatch(/expected a directory/);
  });
});

describe('assertManifestShape strict field validation', () => {
  /** A fully valid v1 manifest with one table and one filesystem file entry. */
  function validManifest(): TenantArchiveManifest {
    const base: Pick<
      TenantArchiveManifest,
      'manifestVersion' | 'tenantId' | 'database' | 'filesystem'
    > = {
      manifestVersion: TENANT_ARCHIVE_MANIFEST_VERSION,
      tenantId: 'acme',
      database: {
        identity,
        tables: [{ name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 }],
      },
      filesystem: {
        included: true,
        entries: [{ path: 'f.txt', type: 'file', size: 3, sha256: HEX, mode: 0o644 }],
        skippedSpecialCount: 0,
        unsafeSymlinkCount: 0,
      },
    };
    return {
      ...base,
      operationId: 'op-valid',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentFingerprint: computeContentFingerprint(base),
    };
  }

  it('accepts a fully valid manifest', () => {
    expect(() => assertManifestShape(validManifest())).not.toThrow();
  });

  it('rejects a non-hex contentFingerprint', () => {
    expect(() => assertManifestShape({ ...validManifest(), contentFingerprint: 'zz' })).toThrow(
      /contentFingerprint/
    );
  });

  it('rejects an invalid identity fingerprint', () => {
    const m = validManifest();
    m.database.identity = { ...identity, fingerprint: 'not-a-hash' };
    expect(() => assertManifestShape(m)).toThrow(/identity\.fingerprint/);
  });

  it('rejects a table with an invalid sha256', () => {
    const m = validManifest();
    m.database.tables = [{ name: 'sessions', rowCount: 1, sha256: 'nope', bytes: 10 }];
    expect(() => assertManifestShape(m)).toThrow(/sha256/);
  });

  it('rejects negative and non-integer numeric fields', () => {
    const neg = validManifest();
    neg.database.tables = [{ name: 'sessions', rowCount: -1, sha256: HEX, bytes: 10 }];
    expect(() => assertManifestShape(neg)).toThrow(/rowCount/);
    const frac = validManifest();
    frac.database.tables = [{ name: 'sessions', rowCount: 1, sha256: HEX, bytes: 1.5 }];
    expect(() => assertManifestShape(frac)).toThrow(/byte size/);
  });

  it('rejects duplicate table names', () => {
    const m = validManifest();
    m.database.tables = [
      { name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 },
      { name: 'sessions', rowCount: 2, sha256: HEX, bytes: 20 },
    ];
    expect(() => assertManifestShape(m)).toThrow(/more than once/);
  });

  it('rejects an unknown filesystem entry type', () => {
    const m = validManifest();
    m.filesystem.entries = [{ path: 'x', type: 'block-device', size: 0, mode: 0o644 } as never];
    expect(() => assertManifestShape(m)).toThrow(/unknown type/);
  });

  it('rejects a file entry missing its sha256', () => {
    const m = validManifest();
    m.filesystem.entries = [{ path: 'f.txt', type: 'file', size: 3, mode: 0o644 } as never];
    expect(() => assertManifestShape(m)).toThrow(/sha256/);
  });

  it('rejects a symlink entry missing its linkTarget', () => {
    const m = validManifest();
    m.filesystem.entries = [{ path: 'l', type: 'symlink', size: 0, mode: 0o777 } as never];
    expect(() => assertManifestShape(m)).toThrow(/linkTarget/);
  });

  it('rejects an out-of-range permission mode', () => {
    const m = validManifest();
    m.filesystem.entries = [
      { path: 'f.txt', type: 'file', size: 3, sha256: HEX, mode: 0o10000 } as never,
    ];
    expect(() => assertManifestShape(m)).toThrow(/mode/);
  });

  it('rejects a special-bit permission mode (e.g. setuid 04755) rather than normalising it', () => {
    // A portable archive never carries setuid/setgid/sticky bits (export strips
    // them), so their presence signals a hand-authored, hostile manifest. The
    // strict validator must refuse it, not silently mask it down.
    for (const mode of [0o4755, 0o2755, 0o1777]) {
      const m = validManifest();
      m.filesystem.entries = [{ path: 'f.txt', type: 'file', size: 3, sha256: HEX, mode } as never];
      // The mode field check runs before the fingerprint recompute, so a stale
      // fingerprint is irrelevant — the special bit is what is rejected.
      expect(() => assertManifestShape(m)).toThrow(/mode/);
    }
    // The equivalent ordinary mode (the default in validManifest) is accepted.
    expect(() => assertManifestShape(validManifest())).not.toThrow();
  });

  it('rejects a filesystem path listed more than once', () => {
    const m = validManifest();
    m.filesystem.entries = [
      { path: 'f.txt', type: 'file', size: 3, sha256: HEX, mode: 0o644 },
      { path: 'f.txt', type: 'file', size: 3, sha256: HEX, mode: 0o644 },
    ];
    expect(() => assertManifestShape(m)).toThrow(/more than once/);
  });
});

describe('assertManifestTablesMatchCatalog', () => {
  const twoTables = makeManifest([
    { name: 'boards', rowCount: 0, sha256: HEX, bytes: 0 },
    { name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 },
  ]);

  it('accepts an exact set regardless of order', () => {
    expect(() => assertManifestTablesMatchCatalog(twoTables, ['sessions', 'boards'])).not.toThrow();
  });

  it('rejects a missing table', () => {
    expect(() =>
      assertManifestTablesMatchCatalog(
        makeManifest([{ name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 }]),
        ['sessions', 'boards']
      )
    ).toThrow(/missing table/);
  });

  it('rejects an unexpected table', () => {
    expect(() => assertManifestTablesMatchCatalog(twoTables, ['sessions'])).toThrow(
      /absent from the live tenant catalog/
    );
  });

  it('rejects a duplicate table', () => {
    const dup = makeManifest([
      { name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 },
      { name: 'sessions', rowCount: 1, sha256: HEX, bytes: 10 },
    ]);
    expect(() => assertManifestTablesMatchCatalog(dup, ['sessions'])).toThrow(/more than once/);
  });
});
