/**
 * Hosted OpenCode native-state checkpointing (`managed-projection`).
 *
 * The live SQLite database, logs, locks, cache, and snapshots stay on
 * Job-local scratch. After a successful turn the executor runs the durability
 * barrier (checkpoint + integrity check + fsync'd immutable copy) and returns a
 * pointer; the daemon accepts that pointer only through the task completion
 * transition. See `context/explorations/opencode-cloud.md` §5–§7.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { OpenCodeNativeStateAttempt } from '@agor/core/types';

/**
 * Job-local scratch root. The Cloud executor pod sets `AGOR_OPENCODE_SCRATCH_ROOT`
 * to its bounded emptyDir mount so the size limit (and "ENOSPC fails the turn")
 * holds even when the image redirects `TMPDIR`; anything else falls back to the
 * process temp directory.
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
  /** XDG_DATA_HOME etc. — all under scratch. */
  xdg: { data: string; config: string; cache: string; state: string };
  /** `OPENCODE_DB` value. */
  liveDbPath: string;
  /** Persistent `.../sessions/<agorSessionId>/attempts` directory under the caller's home. */
  attemptsDir: string;
}

export function resolveOpenCodeNativeStateLayout(input: {
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
  homeDir?: string;
  scratchRoot?: string;
}): OpenCodeNativeStateLayout {
  const home = input.homeDir ?? homedir();
  if (!home) throw new OpenCodeNativeStateError('OpenCode managed state requires a home directory');
  const scratchRoot = resolve(input.scratchRoot ?? resolveOpenCodeScratchRoot(), input.taskId);
  return {
    attemptTaskId: input.taskId,
    scratchRoot,
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
      'attempts'
    ),
  };
}

async function sha256File(path: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes };
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write bytes to `target` via a temp sibling, fsync the file, rename, then fsync the directory. */
async function writeDurably(target: string, content: Buffer | string): Promise<void> {
  const directory = resolve(target, '..');
  const temp = join(directory, `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  await fsyncDirectory(directory);
}

async function copyDurably(source: string, target: string): Promise<void> {
  const directory = resolve(target, '..');
  const temp = join(directory, `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  await copyFile(source, temp);
  const handle = await open(temp, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  await fsyncDirectory(directory);
}

/** Create the Job-local scratch roots (idempotent). */
export async function prepareOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await mkdir(layout.scratchRoot, { recursive: true, mode: 0o700 });
  for (const directory of Object.values(layout.xdg)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

const ATTEMPT_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Remove orphaned attempt directories that are provably older than this Job's
 * launch pointer. Task ids are UUIDv7, so lexical order is publication order:
 * only entries that sort strictly below the accepted attempt (or, without an
 * accepted checkpoint, below this Job's own task) are removed. Anything newer
 * may have been published and accepted by a later Job while this one was
 * still starting (force-fail does not prove process termination), so a stale
 * Job can never delete a checkpoint the daemon has since accepted.
 */
export async function pruneOpenCodeAttempts(
  layout: OpenCodeNativeStateLayout,
  accepted: OpenCodeNativeStateAttempt | null
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(layout.attemptsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const bound = accepted
    ? accepted.attemptTaskId < layout.attemptTaskId
      ? accepted.attemptTaskId
      : layout.attemptTaskId
    : layout.attemptTaskId;
  const removed: string[] = [];
  for (const entry of entries) {
    if (!ATTEMPT_ENTRY.test(entry)) continue;
    if (accepted && entry === accepted.attemptTaskId) continue;
    if (!(entry < bound)) continue;
    await rm(join(layout.attemptsDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

/**
 * Copy the accepted checkpoint into the live database path after verifying
 * the manifest and the payload digest. Any mismatch fails closed; the turn
 * never starts from an empty database when a checkpoint was expected.
 */
export async function restoreOpenCodeAcceptedState(
  layout: OpenCodeNativeStateLayout,
  accepted: OpenCodeNativeStateAttempt
): Promise<void> {
  const attemptDir = join(layout.attemptsDir, accepted.attemptTaskId);
  let manifest: OpenCodeNativeStateAttempt;
  try {
    manifest = JSON.parse(await readFile(join(attemptDir, MANIFEST_FILE), 'utf8'));
  } catch {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint manifest is missing or unreadable'
    );
  }
  if (
    manifest.attemptTaskId !== accepted.attemptTaskId ||
    manifest.digest !== accepted.digest ||
    manifest.bytes !== accepted.bytes ||
    manifest.openCodeSessionId !== accepted.openCodeSessionId
  ) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint manifest does not match the session pointer'
    );
  }
  const source = join(attemptDir, DB_FILE);
  const actual = await sha256File(source).catch(() => undefined);
  if (!actual || actual.digest !== accepted.digest || actual.bytes !== accepted.bytes) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the accepted checkpoint file does not match its digest'
    );
  }
  // A fresh copy must never inherit a stale WAL/SHM pair from scratch; clear
  // them before the copy so no window exists where they could be applied.
  await rm(`${layout.liveDbPath}-wal`, { force: true });
  await rm(`${layout.liveDbPath}-shm`, { force: true });
  await copyFile(source, layout.liveDbPath);
}

export interface OpenCodeCheckpointDependencies {
  /** Seam for tests; production runs the real checkpoint through `node:sqlite`. */
  checkpoint?: (dbPath: string) => Promise<void>;
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

async function checkpointWithNodeSqlite(dbPath: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
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
  const checkpoint = dependencies.checkpoint ?? checkpointWithNodeSqlite;
  try {
    await checkpoint(layout.liveDbPath);
    const remainingWal = await stat(`${layout.liveDbPath}-wal`).catch(() => undefined);
    if (remainingWal && remainingWal.size > 0) {
      throw new OpenCodeNativeStateError('OpenCode checkpoint left uncommitted WAL frames');
    }
    const attemptDir = join(layout.attemptsDir, input.taskId);
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    await copyDurably(layout.liveDbPath, join(attemptDir, DB_FILE));
    const { digest, bytes } = await sha256File(join(attemptDir, DB_FILE));
    const attempt: OpenCodeNativeStateAttempt = {
      version: 1,
      attemptTaskId: input.taskId,
      digest,
      bytes,
      openCodeSessionId: input.openCodeSessionId,
      publishedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    };
    await writeDurably(join(attemptDir, MANIFEST_FILE), JSON.stringify(attempt));
    await fsyncDirectory(layout.attemptsDir);
    return attempt;
  } catch (error) {
    if (error instanceof OpenCodeNativeStateError) throw error;
    throw new OpenCodeNativeStateError(
      `OpenCode checkpoint not durable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Best-effort scratch removal; the Job's filesystem dies with it anyway. */
export async function discardOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await rm(layout.scratchRoot, { recursive: true, force: true }).catch(() => undefined);
}
