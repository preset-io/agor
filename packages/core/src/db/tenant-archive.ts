/**
 * The portable tenant-archive format: a versioned, self-describing directory
 * bundle produced by `export` and consumed by `import` / `verify`. Agor stays
 * ignorant of how the bundle is transported or mounted — it only reads and
 * writes a directory at a path the caller supplies.
 *
 * Layout:
 *
 *   <archive>/
 *     manifest.json            — this manifest (identity, hashes, entries)
 *     database/<table>.jsonl   — one line of canonical JSON per tenant row
 *     files/<relative tree>    — the tenant filesystem tree (safe paths only)
 *
 * The manifest carries: a manifest version, the source tenant id, the operation
 * id that produced it, the runtime-derived database identity (dialect, migration
 * ledger, tenant-table set), a per-table row count and content hash, the
 * filesystem entry list with per-file hashes, and a single `contentFingerprint`
 * over all of that. The fingerprint deliberately excludes wall-clock metadata so
 * two exports of identical tenant data are byte-identical in everything that
 * matters and produce the same fingerprint — the determinism the spec requires.
 *
 * Nothing in the manifest is a secret: it holds identifiers, counts, hashes, and
 * safe relative paths, never row contents, connection strings, or credentials.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenantDatabaseIdentity } from './tenant-catalog';
import {
  assertSafeRelativePath,
  resolveWithinRoot,
  type TenantFilesystemEntry,
  type TenantFilesystemEntryType,
} from './tenant-filesystem';

/** Current manifest schema version. Bump on any incompatible layout change. */
export const TENANT_ARCHIVE_MANIFEST_VERSION = 1;

export const ARCHIVE_MANIFEST_FILENAME = 'manifest.json';
export const ARCHIVE_DATABASE_DIRNAME = 'database';
export const ARCHIVE_FILES_DIRNAME = 'files';

/** Thrown when an archive is missing, malformed, or fails its own hashes. */
export class MalformedArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedArchiveError';
  }
}

/** Per-table entry: name, row count, and the SHA-256 of its `.jsonl` bytes. */
export interface TenantArchiveTable {
  name: string;
  rowCount: number;
  /** SHA-256 hex of the exact bytes written to `database/<name>.jsonl`. */
  sha256: string;
  bytes: number;
}

export interface TenantArchiveManifest {
  manifestVersion: number;
  /** Operation id binding this archive to the run that produced it. */
  operationId: string;
  /** Source tenant id. */
  tenantId: string;
  /** ISO timestamp — informational only; excluded from `contentFingerprint`. */
  createdAt: string;
  database: {
    identity: TenantDatabaseIdentity;
    tables: TenantArchiveTable[];
  };
  filesystem: {
    /** Whether a tenant filesystem tree is included in this archive. */
    included: boolean;
    entries: TenantFilesystemEntry[];
    skippedSpecialCount: number;
    unsafeSymlinkCount: number;
  };
  /** SHA-256 over the canonical, wall-clock-free content of this archive. */
  contentFingerprint: string;
}

/**
 * Reject an operation id that is unsafe to embed in a filesystem path. The
 * importer derives a staging directory name from `manifest.operationId`
 * (`.agor-import-<operationId>`) and then `rm(...,{recursive,force})`s it, so a
 * value containing a path separator, a NUL byte, or a `..` segment could escape
 * that directory and delete an arbitrary tree. The content fingerprint
 * deliberately excludes the operation id, so a hostile id would otherwise pass
 * integrity — this validation, applied at both export entry and manifest
 * validation, is the only line of defense. Mirrors the rejection style of
 * {@link assertSafeRelativePath}.
 */
export function assertSafeOperationId(operationId: string): void {
  if (
    operationId.includes('/') ||
    operationId.includes('\\') ||
    operationId.includes('\0') ||
    operationId.includes('..')
  ) {
    throw new MalformedArchiveError(
      `Unsafe operationId (must not contain path separators, "..", or NUL): ${operationId}`
    );
  }
}

/** Deterministic JSON: object keys sorted recursively, arrays preserved. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the content fingerprint of an archive: a hash over the database
 * identity, per-table hashes, and filesystem entries — everything that defines
 * the archive's payload, and nothing that changes between two identical exports.
 */
export function computeContentFingerprint(
  input: Pick<TenantArchiveManifest, 'manifestVersion' | 'tenantId' | 'database' | 'filesystem'>
): string {
  return sha256Hex(
    canonicalJson({
      manifestVersion: input.manifestVersion,
      tenantId: input.tenantId,
      databaseIdentityFingerprint: input.database.identity.fingerprint,
      schemaVersion: input.database.identity.schemaVersion,
      migrations: input.database.identity.migrations,
      tables: input.database.tables.map((table) => ({
        name: table.name,
        rowCount: table.rowCount,
        sha256: table.sha256,
      })),
      filesystem: {
        included: input.filesystem.included,
        entries: input.filesystem.entries,
        skippedSpecialCount: input.filesystem.skippedSpecialCount,
        unsafeSymlinkCount: input.filesystem.unsafeSymlinkCount,
      },
    })
  );
}

export function manifestPath(archiveRoot: string): string {
  return join(archiveRoot, ARCHIVE_MANIFEST_FILENAME);
}

export function databaseDir(archiveRoot: string): string {
  return join(archiveRoot, ARCHIVE_DATABASE_DIRNAME);
}

export function filesDir(archiveRoot: string): string {
  return join(archiveRoot, ARCHIVE_FILES_DIRNAME);
}

export function tableJsonlPath(archiveRoot: string, tableName: string): string {
  // Table names come from the runtime manifest (never user input) and match a
  // strict identifier shape, so they are safe as a filename component.
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
    throw new MalformedArchiveError(`Unsafe table name in archive: ${tableName}`);
  }
  return join(databaseDir(archiveRoot), `${tableName}.jsonl`);
}

/** Serialise a manifest to stable, human-readable JSON. */
export function serializeManifest(manifest: TenantArchiveManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function writeManifest(
  archiveRoot: string,
  manifest: TenantArchiveManifest
): Promise<void> {
  await writeFile(manifestPath(archiveRoot), serializeManifest(manifest), 'utf8');
}

/**
 * Read and structurally validate an archive manifest. Rejects a missing file,
 * invalid JSON, an unknown manifest version, or a shape that does not match the
 * contract. Does not verify payload hashes — see {@link verifyArchiveIntegrity}.
 */
export async function readManifest(archiveRoot: string): Promise<TenantArchiveManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(archiveRoot), 'utf8');
  } catch {
    throw new MalformedArchiveError(`Archive manifest not found at ${manifestPath(archiveRoot)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedArchiveError('Archive manifest is not valid JSON');
  }
  return assertManifestShape(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/i;
/** setuid/setgid/sticky + rwxrwxrwx — the only bits export preserves. */
const MAX_PERMISSION_MODE = 0o7777;
const FS_ENTRY_TYPES: readonly TenantFilesystemEntryType[] = ['file', 'directory', 'symlink'];

/** Assert a validation predicate, throwing the malformed-archive error on false. */
function assertManifest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MalformedArchiveError(message);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Strictly validate the runtime-derived database identity embedded in a manifest. */
function assertIdentityShape(identity: unknown): void {
  assertManifest(isRecord(identity), 'Archive manifest database.identity must be an object');
  assertManifest(
    identity.dialect === 'postgresql',
    'Archive manifest database.identity.dialect must be "postgresql"'
  );
  assertManifest(
    typeof identity.schemaVersion === 'string' && identity.schemaVersion.length > 0,
    'Archive manifest database.identity.schemaVersion must be a non-empty string'
  );
  assertManifest(
    isStringArray(identity.migrations) &&
      identity.migrations.length > 0 &&
      identity.migrations.every((tag) => tag.length > 0),
    'Archive manifest database.identity.migrations must be a non-empty array of migration tags'
  );
  assertManifest(
    isStringArray(identity.tenantTables),
    'Archive manifest database.identity.tenantTables must be an array of table names'
  );
  assertManifest(
    isStringArray(identity.presentImperativeTables),
    'Archive manifest database.identity.presentImperativeTables must be an array of table names'
  );
  assertManifest(
    isSha256Hex(identity.fingerprint),
    'Archive manifest database.identity.fingerprint must be a SHA-256 hex string'
  );
}

/** Strictly validate a single per-table manifest entry. */
function assertTableShape(table: unknown): void {
  assertManifest(isRecord(table), 'Archive manifest database.tables entries must be objects');
  assertManifest(
    typeof table.name === 'string' && SAFE_TABLE_NAME.test(table.name),
    `Archive manifest has an invalid table name: ${String(table.name)}`
  );
  assertManifest(
    isNonNegativeSafeInteger(table.rowCount),
    `Archive manifest table ${table.name} has an invalid rowCount`
  );
  assertManifest(
    isNonNegativeSafeInteger(table.bytes),
    `Archive manifest table ${table.name} has an invalid byte size`
  );
  assertManifest(
    isSha256Hex(table.sha256),
    `Archive manifest table ${table.name} has an invalid sha256`
  );
}

/** Strictly validate a single filesystem entry, enforcing type-specific fields. */
function assertFilesystemEntryShape(entry: unknown): void {
  assertManifest(isRecord(entry), 'Archive manifest filesystem entry must be an object');
  assertManifest(
    typeof entry.type === 'string' && FS_ENTRY_TYPES.includes(entry.type as never),
    `Archive manifest filesystem entry has an unknown type: ${String(entry.type)}`
  );
  assertManifest(
    typeof entry.path === 'string',
    'Archive manifest filesystem entry path must be a string'
  );
  try {
    assertSafeRelativePath(entry.path);
  } catch {
    throw new MalformedArchiveError(
      `Archive manifest filesystem entry has an unsafe path: ${entry.path}`
    );
  }
  assertManifest(
    isNonNegativeSafeInteger(entry.mode) && entry.mode <= MAX_PERMISSION_MODE,
    `Archive manifest filesystem entry ${entry.path} has an invalid mode`
  );
  if (entry.type === 'file') {
    assertManifest(
      isNonNegativeSafeInteger(entry.size),
      `Archive manifest file entry ${entry.path} has an invalid size`
    );
    // A file entry MUST carry a content hash — integrity checking depends on it,
    // so a missing/short hash is never silently skipped.
    assertManifest(
      isSha256Hex(entry.sha256),
      `Archive manifest file entry ${entry.path} has an invalid sha256`
    );
    assertManifest(
      entry.linkTarget === undefined,
      `Archive manifest file entry ${entry.path} must not carry a linkTarget`
    );
    return;
  }
  // Directory and symlink entries carry no bytes: size is fixed at 0 and they
  // never carry a content hash.
  assertManifest(
    entry.size === 0,
    `Archive manifest ${entry.type} entry ${entry.path} must be 0 bytes`
  );
  assertManifest(
    entry.sha256 === undefined,
    `Archive manifest ${entry.type} entry ${entry.path} must not carry a sha256`
  );
  if (entry.type === 'symlink') {
    assertManifest(
      typeof entry.linkTarget === 'string' &&
        entry.linkTarget.length > 0 &&
        !entry.linkTarget.includes('\0'),
      `Archive manifest symlink entry ${entry.path} has an invalid linkTarget`
    );
  } else {
    assertManifest(
      entry.linkTarget === undefined,
      `Archive manifest directory entry ${entry.path} must not carry a linkTarget`
    );
  }
}

/**
 * Strictly validate the parsed manifest against the version-1 contract before any
 * caller may act on it: exact discriminants, type-specific required fields,
 * SHA-256 formats, nonnegative safe-integer counts/sizes, safe permission modes,
 * and no duplicate/unknown/malformed entries. Structural validation runs BEFORE
 * the fingerprint recompute so a manifest whose attacker recomputed its own
 * fingerprint over malformed fields is still rejected on the field checks rather
 * than trusted. The exact expected TABLE SET is enforced separately, where live
 * catalog context is available — see {@link assertManifestTablesMatchCatalog}.
 */
export function assertManifestShape(parsed: unknown): TenantArchiveManifest {
  assertManifest(isRecord(parsed), 'Archive manifest must be a JSON object');
  assertManifest(
    parsed.manifestVersion === TENANT_ARCHIVE_MANIFEST_VERSION,
    `Unsupported archive manifest version ${String(parsed.manifestVersion)}; this binary understands version ${TENANT_ARCHIVE_MANIFEST_VERSION}`
  );
  assertManifest(
    typeof parsed.tenantId === 'string' && parsed.tenantId.length > 0,
    'Archive manifest is missing a tenantId'
  );
  assertManifest(
    typeof parsed.operationId === 'string' && parsed.operationId.length > 0,
    'Archive manifest is missing an operationId'
  );
  assertSafeOperationId(parsed.operationId);
  assertManifest(
    typeof parsed.createdAt === 'string' && parsed.createdAt.length > 0,
    'Archive manifest is missing a createdAt'
  );
  assertManifest(
    isSha256Hex(parsed.contentFingerprint),
    'Archive manifest contentFingerprint must be a SHA-256 hex string'
  );

  assertManifest(isRecord(parsed.database), 'Archive manifest has a malformed database section');
  assertIdentityShape(parsed.database.identity);
  assertManifest(
    Array.isArray(parsed.database.tables),
    'Archive manifest database.tables must be an array'
  );
  const tableNames = new Set<string>();
  for (const table of parsed.database.tables) {
    assertTableShape(table);
    const name = (table as { name: string }).name;
    assertManifest(!tableNames.has(name), `Archive manifest lists table ${name} more than once`);
    tableNames.add(name);
  }

  assertManifest(
    isRecord(parsed.filesystem),
    'Archive manifest has a malformed filesystem section'
  );
  assertManifest(
    typeof parsed.filesystem.included === 'boolean',
    'Archive manifest filesystem.included must be a boolean'
  );
  assertManifest(
    Array.isArray(parsed.filesystem.entries),
    'Archive manifest filesystem.entries must be an array'
  );
  assertManifest(
    isNonNegativeSafeInteger(parsed.filesystem.skippedSpecialCount),
    'Archive manifest filesystem.skippedSpecialCount must be a nonnegative integer'
  );
  assertManifest(
    isNonNegativeSafeInteger(parsed.filesystem.unsafeSymlinkCount),
    'Archive manifest filesystem.unsafeSymlinkCount must be a nonnegative integer'
  );
  const entryPaths = new Set<string>();
  for (const entry of parsed.filesystem.entries) {
    assertFilesystemEntryShape(entry);
    const path = (entry as { path: string }).path;
    assertManifest(
      !entryPaths.has(path),
      `Archive manifest lists filesystem path ${path} more than once`
    );
    entryPaths.add(path);
  }

  // Every field is now well-typed. Recompute the content fingerprint and compare
  // — a mismatch means the manifest's own metadata is internally inconsistent or
  // was tampered with without regenerating the fingerprint.
  const recomputed = computeContentFingerprint(parsed as unknown as TenantArchiveManifest);
  if (recomputed !== parsed.contentFingerprint) {
    throw new MalformedArchiveError(
      'Archive manifest contentFingerprint does not match its declared contents'
    );
  }
  return parsed as unknown as TenantArchiveManifest;
}

/**
 * Enforce that a validated manifest's table set exactly matches the live tenant
 * catalog's expected movable tables — no missing, extra, or duplicate tables.
 * Requires the caller to supply the expected set (import/verify resolve it from
 * the runtime), so this lives outside the pure {@link assertManifestShape} which
 * has no catalog context.
 */
export function assertManifestTablesMatchCatalog(
  manifest: TenantArchiveManifest,
  expectedTableNames: readonly string[]
): void {
  const expected = new Set(expectedTableNames);
  const seen = new Set<string>();
  for (const table of manifest.database.tables) {
    assertManifest(
      !seen.has(table.name),
      `Archive manifest lists table ${table.name} more than once`
    );
    seen.add(table.name);
    assertManifest(
      expected.has(table.name),
      `Archive manifest lists a table absent from the live tenant catalog: ${table.name}`
    );
  }
  const missing = [...expected].filter((name) => !seen.has(name)).sort();
  assertManifest(
    missing.length === 0,
    `Archive manifest is missing table(s) present in the live tenant catalog: ${missing.join(', ')}`
  );
}

/** Read a table's JSONL payload from the archive as a UTF-8 string. */
export async function readTableJsonl(archiveRoot: string, tableName: string): Promise<string> {
  try {
    return await readFile(tableJsonlPath(archiveRoot, tableName), 'utf8');
  } catch {
    throw new MalformedArchiveError(`Archive is missing database file for table: ${tableName}`);
  }
}

async function sha256FileHex(absolutePath: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const hash = createHash('sha256');
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest('hex');
}

/** Bounded result of re-hashing an archive's payload against its manifest. */
export interface ArchiveIntegrityResult {
  ok: boolean;
  checkedTables: number;
  checkedFiles: number;
  /** Human-readable problem descriptions, capped for bounded output. */
  problems: string[];
  problemCount: number;
}

/**
 * Re-hash every database file and regular filesystem file in an archive and
 * compare against the manifest. This proves the archive on disk matches the
 * hashes the manifest declares — an integrity check independent of any live
 * database. Output is bounded: at most `maxProblems` descriptions are returned.
 */
export async function verifyArchiveIntegrity(
  archiveRoot: string,
  manifest: TenantArchiveManifest,
  options: { maxProblems?: number } = {}
): Promise<ArchiveIntegrityResult> {
  const maxProblems = options.maxProblems ?? 50;
  const problems: string[] = [];
  let problemCount = 0;
  const record = (message: string): void => {
    problemCount += 1;
    if (problems.length < maxProblems) problems.push(message);
  };

  let checkedTables = 0;
  for (const table of manifest.database.tables) {
    let bytes: Buffer;
    try {
      bytes = await readFile(tableJsonlPath(archiveRoot, table.name));
    } catch {
      record(`missing database file for table ${table.name}`);
      continue;
    }
    checkedTables += 1;
    if (bytes.byteLength !== table.bytes) {
      record(`byte size mismatch for table ${table.name}`);
    }
    if (sha256Hex(bytes) !== table.sha256) {
      record(`hash mismatch for table ${table.name}`);
    }
    const lineCount =
      bytes.length === 0 ? 0 : bytes.toString('utf8').replace(/\n$/, '').split('\n').length;
    if (lineCount !== table.rowCount) {
      record(
        `row count mismatch for table ${table.name} (file has ${lineCount}, manifest ${table.rowCount})`
      );
    }
  }

  let checkedFiles = 0;
  const filesRoot = filesDir(archiveRoot);
  for (const entry of manifest.filesystem.entries) {
    let absolute: string;
    try {
      absolute = resolveWithinRoot(filesRoot, entry.path);
    } catch {
      record(`unsafe archive path: ${entry.path}`);
      continue;
    }
    // lstat so an entry's own type is checked (a symlink is classified as such,
    // not followed). Directory and symlink entries are confirmed to exist with
    // the expected type — no hashing needed — so verify is a fuller preflight
    // that the entire archived tree is materialisable, not just its file bytes.
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch {
      record(`missing archived ${entry.type}: ${entry.path}`);
      continue;
    }
    if (entry.type === 'directory') {
      if (!info.isDirectory()) {
        record(`expected a directory at archived path: ${entry.path}`);
      }
      continue;
    }
    if (entry.type === 'symlink') {
      if (!info.isSymbolicLink()) {
        record(`expected a symlink at archived path: ${entry.path}`);
      }
      continue;
    }
    if (!info.isFile()) {
      record(`expected a regular file at archived path: ${entry.path}`);
      continue;
    }
    checkedFiles += 1;
    if (info.size !== entry.size) {
      record(`size mismatch for archived file: ${entry.path}`);
      continue;
    }
    // A file entry without a content hash is not a pass — strict manifest
    // validation forbids it, and standalone callers must not silently skip it.
    if (!entry.sha256) {
      record(`archived file has no content hash: ${entry.path}`);
      continue;
    }
    if ((await sha256FileHex(absolute)) !== entry.sha256) {
      record(`hash mismatch for archived file: ${entry.path}`);
    }
  }

  return { ok: problemCount === 0, checkedTables, checkedFiles, problems, problemCount };
}
