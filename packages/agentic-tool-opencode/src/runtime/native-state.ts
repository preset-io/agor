/**
 * Hosted OpenCode native-state checkpointing (`managed-projection`).
 *
 * The live SQLite database, logs, locks, cache, and snapshots stay on
 * Job-local scratch. After a successful turn the executor runs the durability
 * barrier (checkpoint + integrity check + fsync'd immutable copy) and returns a
 * pointer; the daemon accepts that pointer only through the task completion
 * transition. See `context/explorations/opencode-cloud.md` §5–§7.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OpenCodeNativeStateAttempt } from '@agor/core/types';
import { OPENCODE_VERSION } from '../shared/known-models.js';

/**
 * Job-local scratch root. The Cloud executor pod sets `AGOR_OPENCODE_SCRATCH_ROOT`
 * to its bounded emptyDir mount. A missing/relative root fails closed, even
 * when the image redirects `TMPDIR`. The mount limit may cause pod eviction;
 * it is not a writer-facing ENOSPC quota.
 */
export const OPENCODE_SCRATCH_ROOT_ENV = 'AGOR_OPENCODE_SCRATCH_ROOT';

export function resolveOpenCodeScratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[OPENCODE_SCRATCH_ROOT_ENV]?.trim();
  if (configured && isAbsolute(configured)) return configured;
  // Managed turns never fall back to the process temp directory: `os.tmpdir()`
  // honors TMPDIR, which a substrate may point at the persistent home, and the
  // live WAL must never land on the network filesystem. Fail before any
  // provider call instead of trusting an unpinned image.
  throw new OpenCodeNativeStateError(
    `OpenCode managed scratch root is not pinned: ${OPENCODE_SCRATCH_ROOT_ENV} must be an absolute path on Job-local storage`
  );
}
const DB_FILE = 'opencode.db';
const MANIFEST_FILE = 'manifest.json';

export class OpenCodeNativeStateError extends Error {
  override name = 'OpenCodeNativeStateError';
}

export interface OpenCodeNativeStateLayout {
  /** The task this Job runs; attempts newer than it are never this Job's to remove. */
  attemptTaskId: string;
  /** Job-private root for every XDG home plus the live database. */
  scratchRoot: string;
  homeDir: string;
  namespaceKey: string;
  agorSessionId: string;
  storeId: string;
  /** XDG_DATA_HOME etc. — all under scratch. */
  xdg: { data: string; config: string; cache: string; state: string };
  /** `OPENCODE_DB` value. */
  liveDbPath: string;
  /** Persistent `.../sessions/<session>/stores/<store>/attempts` directory. */
  attemptsDir: string;
}

export function resolveOpenCodeNativeStateLayout(input: {
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
  storeId: string;
  homeDir?: string;
  scratchRoot?: string;
}): OpenCodeNativeStateLayout {
  // UUIDv7 ordering and on-disk paths use one canonical lowercase spelling.
  if (
    !ATTEMPT_ENTRY.test(input.taskId) ||
    !ATTEMPT_ENTRY.test(input.agorSessionId) ||
    !ATTEMPT_ENTRY.test(input.storeId) ||
    !/^[0-9a-f]{64}$/.test(input.namespaceKey)
  ) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state requires canonical lowercase session and task ids'
    );
  }
  const home = input.homeDir ?? homedir();
  if (!home) throw new OpenCodeNativeStateError('OpenCode managed state requires a home directory');
  const scratchRoot = resolve(input.scratchRoot ?? resolveOpenCodeScratchRoot(), input.taskId);
  return {
    attemptTaskId: input.taskId,
    scratchRoot,
    homeDir: resolve(home),
    namespaceKey: input.namespaceKey,
    agorSessionId: input.agorSessionId,
    storeId: input.storeId,
    xdg: {
      data: join(scratchRoot, 'xdg-data'),
      config: join(scratchRoot, 'xdg-config'),
      cache: join(scratchRoot, 'xdg-cache'),
      state: join(scratchRoot, 'xdg-state'),
    },
    liveDbPath: join(scratchRoot, DB_FILE),
    attemptsDir: join(
      home,
      '.local',
      'share',
      'agor',
      'opencode',
      input.namespaceKey,
      'sessions',
      input.agorSessionId,
      'stores',
      input.storeId,
      'attempts'
    ),
  };
}

const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY = constants.O_DIRECTORY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function isManagedManifestV3(
  value: unknown
): value is Extract<OpenCodeNativeStateAttempt, { version: 3 }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 3 &&
    Object.keys(candidate).length === 8 &&
    typeof candidate.storeId === 'string' &&
    UUID.test(candidate.storeId) &&
    typeof candidate.attemptTaskId === 'string' &&
    UUID.test(candidate.attemptTaskId) &&
    typeof candidate.digest === 'string' &&
    SHA256.test(candidate.digest) &&
    typeof candidate.bytes === 'number' &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.openCodeSessionId === 'string' &&
    candidate.openCodeSessionId.length > 0 &&
    candidate.openCodeSessionId.length <= 200 &&
    typeof candidate.openCodeVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(candidate.openCodeVersion) &&
    typeof candidate.publishedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.publishedAt))
  );
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  if (typeof NOFOLLOW !== 'number' || typeof DIRECTORY !== 'number') {
    throw new OpenCodeNativeStateError(
      'Managed OpenCode filesystem does not support no-follow directory operations'
    );
  }
  const absolute = resolve(path);
  if (!isAbsolute(absolute))
    throw new OpenCodeNativeStateError('Managed OpenCode path is not absolute');
  const segments = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const segment of segments) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      await fsyncDirectory(resolve(current, '..'));
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new OpenCodeNativeStateError(
        'Managed OpenCode path contains a non-directory or symlink ancestor'
      );
    }
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory())
      throw new OpenCodeNativeStateError('Managed OpenCode durability path is not a directory');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openRegularFile(
  path: string,
  flags = constants.O_RDONLY
): Promise<Awaited<ReturnType<typeof open>>> {
  await ensureSafeDirectory(resolve(path, '..'), false);
  const handle = await open(path, flags | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new OpenCodeNativeStateError(
        'Managed OpenCode payload must be a single-link regular file'
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyOpenedFile(
  sourcePath: string,
  targetPath: string
): Promise<{ digest: string; bytes: number }> {
  const source = await openRegularFile(sourcePath);
  const directory = resolve(targetPath, '..');
  await ensureSafeDirectory(directory, false);
  const temp = join(directory, `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
  const destination = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
    0o600
  );
  const hash = createHash('sha256');
  let bytes = 0;
  let copyFailure: unknown;
  const digestTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(sourcePath, { fd: source.fd, autoClose: false }),
      digestTransform,
      createWriteStream(temp, { fd: destination.fd, autoClose: false })
    );
    await destination.sync();
  } catch (error) {
    copyFailure = error;
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
  if (copyFailure) {
    await unlink(temp).catch(() => undefined);
    throw copyFailure;
  }
  const info = await lstat(temp);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new OpenCodeNativeStateError(
      'Managed OpenCode copied payload is not a private regular file'
    );
  }
  try {
    await link(temp, targetPath);
    await unlink(temp);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes };
}

async function writeDurablyExclusive(target: string, content: string): Promise<void> {
  const directory = resolve(target, '..');
  await ensureSafeDirectory(directory, false);
  const temp = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, target);
    await unlink(temp);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Create the Job-local scratch roots (idempotent). */
export async function prepareOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await ensureSafeDirectory(layout.scratchRoot, true);
  for (const directory of Object.values(layout.xdg)) {
    await ensureSafeDirectory(directory, true);
  }
}

const ATTEMPT_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Copy the accepted checkpoint into the live database path after verifying
 * the manifest and the payload digest. Any mismatch fails closed; the turn
 * never starts from an empty database when a checkpoint was expected.
 */
export async function restoreOpenCodeAcceptedState(
  layout: OpenCodeNativeStateLayout,
  accepted: OpenCodeNativeStateAttempt
): Promise<void> {
  if (
    !isManagedManifestV3(accepted) ||
    accepted.storeId !== layout.storeId ||
    accepted.version !== 3 ||
    accepted.openCodeVersion !== OPENCODE_VERSION
  ) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: checkpoint runtime version is missing or incompatible; use its matching runtime or start a new session'
    );
  }
  const attemptDir = join(layout.attemptsDir, accepted.attemptTaskId);
  let manifest: unknown;
  try {
    await ensureSafeDirectory(attemptDir, false);
    const handle = await openRegularFile(join(attemptDir, MANIFEST_FILE));
    try {
      manifest = JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally {
      await handle.close();
    }
  } catch {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint manifest is missing or unreadable'
    );
  }
  if (
    !isManagedManifestV3(manifest) ||
    manifest.version !== 3 ||
    manifest.storeId !== layout.storeId ||
    manifest.openCodeVersion !== accepted.openCodeVersion ||
    manifest.attemptTaskId !== accepted.attemptTaskId ||
    manifest.digest !== accepted.digest ||
    manifest.bytes !== accepted.bytes ||
    manifest.openCodeSessionId !== accepted.openCodeSessionId ||
    manifest.publishedAt !== accepted.publishedAt
  ) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint manifest does not match the session pointer'
    );
  }
  const source = join(attemptDir, DB_FILE);
  let actual: { digest: string; bytes: number } | undefined;
  try {
    const handle = await openRegularFile(source);
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(source, { fd: handle.fd, autoClose: false })) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
      }
      actual = { digest: `sha256:${hash.digest('hex')}`, bytes };
    } finally {
      await handle.close();
    }
  } catch {
    actual = undefined;
  }
  if (!actual || actual.digest !== accepted.digest || actual.bytes !== accepted.bytes) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint file does not match its digest'
    );
  }
  // This scratch path is unique to the admitted Task. Existing bytes or a WAL
  // sidecar indicate path reuse; never erase them or let SQLite apply them.
  for (const path of [layout.liveDbPath, `${layout.liveDbPath}-wal`, `${layout.liveDbPath}-shm`]) {
    try {
      await lstat(path);
      throw new OpenCodeNativeStateError('OpenCode scratch database path is already occupied');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const copied = await copyOpenedFile(source, layout.liveDbPath).catch((error) => {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: accepted checkpoint copy failed',
      { cause: error }
    );
  });
  if (copied.digest !== accepted.digest || copied.bytes !== accepted.bytes) {
    await unlink(layout.liveDbPath).catch(() => undefined);
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: copied checkpoint failed verification'
    );
  }
}

export interface OpenCodeCheckpointDependencies {
  /** Seam for tests; production runs the real checkpoint through `node:sqlite`. */
  checkpoint?: (dbPath: string, openCodeSessionId: string) => Promise<void>;
  now?: () => Date;
}

/**
 * The durability barrier needs `node:sqlite`, unflagged only from Node 22.13.
 * Probe it before the provider turn so an older executor image fails with an
 * actionable message instead of wasting a full turn on "checkpoint not durable".
 */
export async function assertOpenCodeCheckpointRuntime(
  importSqlite: () => Promise<unknown> = () => import('node:sqlite')
): Promise<void> {
  try {
    await importSqlite();
  } catch (error) {
    throw new OpenCodeNativeStateError(
      'This executor runtime lacks node:sqlite; Node 22.13 or newer is required for hosted OpenCode checkpoints',
      { cause: error }
    );
  }
}

async function checkpointWithNodeSqlite(dbPath: string, openCodeSessionId: string): Promise<void> {
  await ensureSafeDirectory(resolve(dbPath, '..'), false);
  const existing = await lstat(dbPath);
  if (
    existing.isSymbolicLink() ||
    !existing.isFile() ||
    existing.nlink !== 1 ||
    existing.size === 0
  ) {
    throw new OpenCodeNativeStateError('OpenCode checkpoint database is missing or empty');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    // Integrity alone accepts arbitrary SQLite files. Require the native session
    // table and the exact session this successful turn claims to checkpoint.
    if (!db.prepare('SELECT id FROM session WHERE id = ?').get(openCodeSessionId)) {
      throw new OpenCodeNativeStateError(
        'OpenCode checkpoint does not contain the completed session'
      );
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy?: number }
      | undefined;
    if (checkpoint?.busy) {
      throw new OpenCodeNativeStateError('OpenCode checkpoint was blocked by a live writer');
    }
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new OpenCodeNativeStateError('OpenCode checkpoint failed its integrity check');
    }
  } finally {
    db.close();
  }
}

/**
 * Durability barrier + immutable publication. Call only after the OpenCode
 * server has exited. Returns the pointer the executor reports with completion;
 * any failure means the turn must be reported failed.
 */
export async function publishOpenCodeCheckpoint(
  layout: OpenCodeNativeStateLayout,
  input: { taskId: string; openCodeSessionId: string },
  dependencies: OpenCodeCheckpointDependencies = {}
): Promise<OpenCodeNativeStateAttempt> {
  if (input.taskId !== layout.attemptTaskId || !ATTEMPT_ENTRY.test(input.taskId)) {
    throw new OpenCodeNativeStateError(
      'OpenCode checkpoint task does not match its canonical layout identity'
    );
  }
  const checkpoint = dependencies.checkpoint ?? checkpointWithNodeSqlite;
  try {
    await checkpoint(layout.liveDbPath, input.openCodeSessionId);
    const remainingWal = await lstat(`${layout.liveDbPath}-wal`).catch(() => undefined);
    if (
      remainingWal &&
      (remainingWal.isSymbolicLink() || !remainingWal.isFile() || remainingWal.nlink !== 1)
    ) {
      throw new OpenCodeNativeStateError(
        'OpenCode checkpoint WAL path is not a private regular file'
      );
    }
    if (remainingWal && remainingWal.size > 0) {
      throw new OpenCodeNativeStateError('OpenCode checkpoint left uncommitted WAL frames');
    }
    await ensureSafeDirectory(layout.homeDir, true);
    await ensureSafeDirectory(layout.attemptsDir, true);
    const attemptDir = join(layout.attemptsDir, input.taskId);
    await mkdir(attemptDir, { mode: 0o700 });
    await fsyncDirectory(layout.attemptsDir);
    const { digest, bytes } = await copyOpenedFile(layout.liveDbPath, join(attemptDir, DB_FILE));
    if (bytes <= 0) throw new OpenCodeNativeStateError('OpenCode checkpoint database is empty');
    const attempt: OpenCodeNativeStateAttempt = {
      version: 3,
      storeId: layout.storeId,
      openCodeVersion: OPENCODE_VERSION,
      attemptTaskId: input.taskId,
      digest,
      bytes,
      openCodeSessionId: input.openCodeSessionId,
      publishedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    };
    await writeDurablyExclusive(join(attemptDir, MANIFEST_FILE), JSON.stringify(attempt));
    await fsyncDirectory(attemptDir);
    return attempt;
  } catch (error) {
    if (error instanceof OpenCodeNativeStateError) throw error;
    throw new OpenCodeNativeStateError(
      `OpenCode checkpoint not durable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Delete exactly one already-retired store/task object; never enumerate or prune siblings. */
export async function deleteRetiredOpenCodeAttempt(
  layout: OpenCodeNativeStateLayout,
  object: { storeId: string; taskId: string }
): Promise<void> {
  if (
    object.storeId !== layout.storeId ||
    !UUID.test(object.storeId) ||
    !UUID.test(object.taskId)
  ) {
    throw new OpenCodeNativeStateError(
      'OpenCode deletion identity does not match its immutable store'
    );
  }
  const directory = join(layout.attemptsDir, object.taskId);
  try {
    await ensureSafeDirectory(directory, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const names = await readdir(directory);
  const allowed = new Set([DB_FILE, MANIFEST_FILE]);
  const knownTemp = names.filter((name) =>
    /^\.(?:opencode\.db|manifest\.json)\.tmp-\d+-[0-9a-f-]{36}$/.test(name)
  );
  for (const name of names) {
    if (allowed.has(name) || knownTemp.includes(name)) continue;
    throw new OpenCodeNativeStateError('OpenCode attempt directory contains an unknown entry');
  }
  // A failed no-clobber link publication can leave its private temp hardlink.
  // Remove only that exact known alias first; any external hardlink still has
  // link count >1 when the payload is checked below.
  for (const name of knownTemp) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 2) {
      throw new OpenCodeNativeStateError('OpenCode deletion refused an unsafe temporary entry');
    }
    if (info.nlink === 2) {
      const target = join(directory, name.startsWith('.opencode.db.') ? DB_FILE : MANIFEST_FILE);
      const targetInfo = await lstat(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !targetInfo ||
        targetInfo.isSymbolicLink() ||
        !targetInfo.isFile() ||
        targetInfo.nlink !== 2 ||
        targetInfo.dev !== info.dev ||
        targetInfo.ino !== info.ino
      ) {
        throw new OpenCodeNativeStateError(
          'OpenCode deletion refused an unpaired temporary hardlink'
        );
      }
    }
    await unlink(path);
  }
  for (const name of names.filter((entry) => allowed.has(entry))) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new OpenCodeNativeStateError(
        'OpenCode deletion refused a symlink, non-file, or hardlinked payload'
      );
    }
    await unlink(path);
  }
  await fsyncDirectory(directory);
  await rmdir(directory);
  await fsyncDirectory(layout.attemptsDir);
}

const DELETE_WORKER_SOURCE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const C = require('node:fs').constants;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (errorCode) => { process.stdout.write(JSON.stringify({version:1,outcome:'failed',errorCode})); process.exitCode = 1; };
async function safeDir(value) {
  if (!path.isAbsolute(value) || C.O_NOFOLLOW === undefined || C.O_DIRECTORY === undefined) throw new Error('unsafe');
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe');
  }
}
async function fsyncDir(value) {
  const fd = await fs.open(value, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function main() {
  let input = '';
  for await (const part of process.stdin) { input += part; if (Buffer.byteLength(input) > 4096) throw new Error('input'); }
  const v = JSON.parse(input);
  if (!v || Object.keys(v).length !== 5 || !UUID.test(v.sessionId) || !UUID.test(v.storeId) || !UUID.test(v.taskId) || !/^[0-9a-f]{64}$/.test(v.namespaceKey) || !path.isAbsolute(v.homeDir)) throw new Error('identity');
  const attempts = path.join(v.homeDir,'.local','share','agor','opencode',v.namespaceKey,'sessions',v.sessionId,'stores',v.storeId,'attempts');
  const dir = path.join(attempts,v.taskId);
  try { await safeDir(dir); } catch (e) { if (e && e.code === 'ENOENT') { process.stdout.write(JSON.stringify({version:1,outcome:'deleted'})); return; } throw e; }
  const names = await fs.readdir(dir);
  const allowed = new Set(['opencode.db','manifest.json']);
  const temps = names.filter(n => /^\.(?:opencode\.db|manifest\.json)\.tmp-\d+-[0-9a-f-]{36}$/.test(n));
  if (names.some(n => !allowed.has(n) && !temps.includes(n))) throw new Error('unknown');
  for (const name of temps) {
    const file = path.join(dir,name); const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 2) throw new Error('unsafe');
    if (info.nlink === 2) {
      const target = path.join(dir, name.startsWith('.opencode.db.') ? 'opencode.db' : 'manifest.json');
      let targetInfo;
      try { targetInfo = await fs.lstat(target); } catch (e) { if (e && e.code === 'ENOENT') throw new Error('unsafe'); throw e; }
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 2 ||
          targetInfo.dev !== info.dev || targetInfo.ino !== info.ino) throw new Error('unsafe');
    }
    await fs.unlink(file);
  }
  for (const name of names.filter(n => allowed.has(n))) {
    const file = path.join(dir,name);
    try { const info = await fs.lstat(file); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('unsafe'); await fs.unlink(file); }
    catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
  await fsyncDir(dir); await fs.rmdir(dir); await fsyncDir(attempts);
  process.stdout.write(JSON.stringify({version:1,outcome:'deleted'}));
}
main().catch(e => fail(e && e.message === 'unknown' ? 'UNKNOWN_ENTRY' : e && e.message === 'unsafe' ? 'UNSAFE_PATH' : e && e.message === 'identity' ? 'INVALID_IDENTITY' : 'FILESYSTEM_ERROR'));
`;

/**
 * Run one exact tombstone deletion in a child process with an independent
 * libuv pool and no daemon/provider credentials. A timeout is not closure: if
 * the child does not exit after SIGKILL this promise intentionally stays open.
 */
export async function deleteRetiredOpenCodeAttemptInWorker(
  layout: OpenCodeNativeStateLayout,
  object: { storeId: string; taskId: string },
  timeoutMs = 2_500
): Promise<{ outcome: 'deleted' } | { outcome: 'failed'; errorCode: string }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    return { outcome: 'failed', errorCode: 'INVALID_TIMEOUT' };
  }
  if (
    object.storeId !== layout.storeId ||
    !UUID.test(object.storeId) ||
    !UUID.test(object.taskId)
  ) {
    return { outcome: 'failed', errorCode: 'INVALID_IDENTITY' };
  }
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['-e', DELETE_WORKER_SOURCE], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: layout.homeDir },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: { outcome: 'deleted' } | { outcome: 'failed'; errorCode: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 4096) child.kill('SIGKILL');
    });
    child.on('error', () => finish({ outcome: 'failed', errorCode: 'WORKER_START_FAILED' }));
    // Parse only after stdout has closed, not merely after the process exits.
    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        const exact = (keys: string[]) =>
          Object.keys(result).length === keys.length &&
          keys.every((key) => Object.hasOwn(result, key));
        if (
          result.version !== 1 ||
          !['deleted', 'failed'].includes(String(result.outcome)) ||
          (result.outcome === 'deleted' && !exact(['version', 'outcome'])) ||
          (result.outcome === 'failed' &&
            (!exact(['version', 'outcome', 'errorCode']) ||
              typeof result.errorCode !== 'string' ||
              !/^[A-Z0-9_]{1,96}$/.test(result.errorCode)))
        ) {
          throw new Error('bad response');
        }
        if (result.outcome === 'deleted' && code === 0 && !timedOut) finish({ outcome: 'deleted' });
        else
          finish({
            outcome: 'failed',
            errorCode: timedOut
              ? 'WORKER_TIMEOUT'
              : String(result.errorCode ?? 'WORKER_FAILED').slice(0, 96),
          });
      } catch {
        finish({ outcome: 'failed', errorCode: timedOut ? 'WORKER_TIMEOUT' : 'WORKER_FAILED' });
      }
    });
    child.stdin?.on('error', () => child.kill('SIGKILL'));
    child.stdin?.end(
      JSON.stringify({
        homeDir: layout.homeDir,
        namespaceKey: layout.namespaceKey,
        sessionId: layout.agorSessionId,
        storeId: object.storeId,
        taskId: object.taskId,
      })
    );
  });
}

/** Best-effort scratch removal; the Job's filesystem dies with it anyway. */
export async function discardOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await rm(layout.scratchRoot, { recursive: true, force: true }).catch(() => undefined);
}
