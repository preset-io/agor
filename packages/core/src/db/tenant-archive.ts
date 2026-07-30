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
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenantDatabaseIdentity } from './tenant-catalog';
import { resolveWithinRoot, type TenantFilesystemEntry } from './tenant-filesystem';

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

/** Validate the parsed manifest against the contract, throwing on any mismatch. */
export function assertManifestShape(parsed: unknown): TenantArchiveManifest {
  if (!isRecord(parsed)) {
    throw new MalformedArchiveError('Archive manifest must be a JSON object');
  }
  const version = parsed.manifestVersion;
  if (version !== TENANT_ARCHIVE_MANIFEST_VERSION) {
    throw new MalformedArchiveError(
      `Unsupported archive manifest version ${String(version)}; this binary understands version ${TENANT_ARCHIVE_MANIFEST_VERSION}`
    );
  }
  if (typeof parsed.tenantId !== 'string' || parsed.tenantId.length === 0) {
    throw new MalformedArchiveError('Archive manifest is missing a tenantId');
  }
  if (typeof parsed.operationId !== 'string' || parsed.operationId.length === 0) {
    throw new MalformedArchiveError('Archive manifest is missing an operationId');
  }
  if (typeof parsed.contentFingerprint !== 'string' || parsed.contentFingerprint.length === 0) {
    throw new MalformedArchiveError('Archive manifest is missing a contentFingerprint');
  }
  const database = parsed.database;
  if (!isRecord(database) || !isRecord(database.identity) || !Array.isArray(database.tables)) {
    throw new MalformedArchiveError('Archive manifest has a malformed database section');
  }
  const filesystem = parsed.filesystem;
  if (!isRecord(filesystem) || !Array.isArray(filesystem.entries)) {
    throw new MalformedArchiveError('Archive manifest has a malformed filesystem section');
  }
  // Recompute the content fingerprint and compare — a mismatch means the
  // manifest's own metadata was tampered with or is internally inconsistent.
  const recomputed = computeContentFingerprint(parsed as unknown as TenantArchiveManifest);
  if (recomputed !== parsed.contentFingerprint) {
    throw new MalformedArchiveError(
      'Archive manifest contentFingerprint does not match its declared contents'
    );
  }
  return parsed as unknown as TenantArchiveManifest;
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
    if (entry.type !== 'file') continue;
    let absolute: string;
    try {
      absolute = resolveWithinRoot(filesRoot, entry.path);
    } catch {
      record(`unsafe archive path: ${entry.path}`);
      continue;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      record(`missing archived file: ${entry.path}`);
      continue;
    }
    checkedFiles += 1;
    if (info.size !== entry.size) {
      record(`size mismatch for archived file: ${entry.path}`);
      continue;
    }
    if (entry.sha256 && (await sha256FileHex(absolute)) !== entry.sha256) {
      record(`hash mismatch for archived file: ${entry.path}`);
    }
  }

  return { ok: problemCount === 0, checkedTables, checkedFiles, problems, problemCount };
}
