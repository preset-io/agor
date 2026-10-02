/** Hosted OpenCode native state: live SQLite on scratch, immutable per-turn checkpoints in the owner's or branch SDK home. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  OpenCodeCheckpointManifest,
  OpenCodeCheckpointObject,
  SessionSdkHomeScope,
} from '@agor/core/types';
import { OPENCODE_VERSION } from '../shared/known-models.js';

/** Cloud pins this to the Job's bounded emptyDir; there is no temp-directory fallback. */
export const OPENCODE_SCRATCH_ROOT_ENV = 'AGOR_OPENCODE_SCRATCH_ROOT';
/** The launcher pins this to the branch SDK home's OpenCode directory for shared Sessions. */
export const OPENCODE_CHECKPOINT_ROOT_ENV = 'AGOR_OPENCODE_CHECKPOINT_ROOT';
const DB_FILE = 'opencode.db';
/** OpenCode tables that hold tokens; a checkpoint may reach collaborators, so they must stay empty. */
const CREDENTIAL_TABLES = ['account', 'control_account', 'credential'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class OpenCodeNativeStateError extends Error {
  override name = 'OpenCodeNativeStateError';
}

export interface OpenCodeNativeStateLayout {
  sessionId: string;
  taskId: string;
  /** Job-private root for every XDG home plus the live database. */
  scratchRoot: string;
  xdg: { data: string; config: string; cache: string; state: string };
  liveDbPath: string;
  /** Persistent checkpoint directory: `$HOME/.agor/opencode/sessions` of the owner, or the branch SDK home's. */
  sessionsDir: string;
}

export function resolveOpenCodeNativeStateLayout(input: {
  sessionId: string;
  taskId: string;
  sdkHomeScope: SessionSdkHomeScope;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): OpenCodeNativeStateLayout {
  if (!UUID.test(input.sessionId) || !UUID.test(input.taskId)) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state requires canonical session and task ids'
    );
  }
  const env = input.env ?? process.env;
  const scratch = env[OPENCODE_SCRATCH_ROOT_ENV]?.trim();
  if (!scratch || !isAbsolute(scratch)) {
    // Never fall back to TMPDIR: it may point at the persistent network home.
    throw new OpenCodeNativeStateError(
      `${OPENCODE_SCRATCH_ROOT_ENV} must be an absolute path on Job-local storage`
    );
  }
  let sessionsDir: string;
  if (input.sdkHomeScope === 'branch') {
    const root = env[OPENCODE_CHECKPOINT_ROOT_ENV]?.trim();
    if (!root || !isAbsolute(root)) {
      // Never fall back to the caller's home: teammates' turns could not restore from it.
      throw new OpenCodeNativeStateError(
        `${OPENCODE_CHECKPOINT_ROOT_ENV} must be an absolute path in the branch SDK home`
      );
    }
    sessionsDir = join(root, 'sessions');
  } else if (input.sdkHomeScope === 'execution_home') {
    const home = input.homeDir ?? homedir();
    if (!home || !isAbsolute(home)) {
      throw new OpenCodeNativeStateError(
        'OpenCode native state requires an absolute home directory'
      );
    }
    sessionsDir = join(home, '.agor', 'opencode', 'sessions');
  } else {
    throw new OpenCodeNativeStateError('OpenCode native state requires a known SDK-home scope');
  }
  const scratchRoot = join(scratch, input.taskId);
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    scratchRoot,
    xdg: {
      data: join(scratchRoot, 'xdg-data'),
      config: join(scratchRoot, 'xdg-config'),
      cache: join(scratchRoot, 'xdg-cache'),
      state: join(scratchRoot, 'xdg-state'),
    },
    liveDbPath: join(scratchRoot, DB_FILE),
    sessionsDir,
  };
}

function attemptDir(layout: OpenCodeNativeStateLayout, object: OpenCodeCheckpointObject): string {
  if (!UUID.test(object.sessionId) || !UUID.test(object.taskId)) {
    throw new OpenCodeNativeStateError('OpenCode checkpoint object ids are not canonical');
  }
  return join(layout.sessionsDir, object.sessionId, 'attempts', object.taskId);
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function digestFile(path: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes };
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Create the Job-private scratch roots; a reused Task path fails closed. */
export async function prepareOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await mkdir(join(layout.scratchRoot, '..'), { recursive: true, mode: 0o700 });
  await mkdir(layout.scratchRoot, { mode: 0o700 });
  for (const directory of Object.values(layout.xdg)) await mkdir(directory, { mode: 0o700 });
}

export async function discardOpenCodeScratch(layout: OpenCodeNativeStateLayout): Promise<void> {
  await rm(layout.scratchRoot, { recursive: true, force: true });
}

/** Copy the accepted checkpoint to scratch; any mismatch fails closed rather than restarting empty. */
export async function restoreOpenCodeCheckpoint(
  layout: OpenCodeNativeStateLayout,
  accepted: OpenCodeCheckpointManifest
): Promise<void> {
  // OpenCode migrates its own database forward on open; only a downgrade is refused.
  if (compareVersions(accepted.openCodeVersion, OPENCODE_VERSION) > 0) {
    throw new OpenCodeNativeStateError(
      `OpenCode native state unavailable: it was saved by newer OpenCode ${accepted.openCodeVersion}`
    );
  }
  const source = join(
    attemptDir(layout, { sessionId: layout.sessionId, taskId: accepted.taskId }),
    DB_FILE
  );
  try {
    await copyFile(source, layout.liveDbPath);
  } catch (error) {
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the saved conversation is missing from its checkpoint store',
      { cause: error }
    );
  }
  const copied = await digestFile(layout.liveDbPath);
  if (copied.digest !== accepted.digest || copied.bytes !== accepted.bytes) {
    await rm(layout.liveDbPath, { force: true });
    throw new OpenCodeNativeStateError(
      'OpenCode native state unavailable: the saved conversation failed verification'
    );
  }
}

/** Fail before a provider turn when the executor image cannot run the durability barrier. */
export async function assertOpenCodeCheckpointRuntime(
  importSqlite: () => Promise<unknown> = () => import('node:sqlite')
): Promise<void> {
  try {
    await importSqlite();
  } catch (error) {
    throw new OpenCodeNativeStateError(
      'Hosted OpenCode requires node:sqlite (Node 22.13 or newer) in the executor image',
      { cause: error }
    );
  }
}

async function checkpointLiveDatabase(dbPath: string, openCodeSessionId: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    // Integrity alone accepts any SQLite file; require the session this turn completed.
    if (!db.prepare('SELECT id FROM session WHERE id = ?').get(openCodeSessionId)) {
      throw new OpenCodeNativeStateError(
        'OpenCode checkpoint does not contain the completed session'
      );
    }
    for (const table of CREDENTIAL_TABLES) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists && db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) {
        throw new OpenCodeNativeStateError('OpenCode checkpoint contains stored credentials');
      }
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number };
    if (checkpoint?.busy) {
      throw new OpenCodeNativeStateError('OpenCode checkpoint was blocked by a live writer');
    }
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (integrity?.integrity_check !== 'ok') {
      throw new OpenCodeNativeStateError('OpenCode checkpoint failed its integrity check');
    }
  } finally {
    db.close();
  }
  const wal = await lstat(`${dbPath}-wal`).catch(() => undefined);
  if (wal && wal.size > 0) {
    throw new OpenCodeNativeStateError('OpenCode checkpoint left uncommitted WAL frames');
  }
}

/** After the server exits: fold the WAL, verify, and publish this Task's attempt (created exclusively). */
export async function sealOpenCodeCheckpoint(
  layout: OpenCodeNativeStateLayout,
  openCodeSessionId: string,
  checkpoint: (dbPath: string, sessionId: string) => Promise<void> = checkpointLiveDatabase
): Promise<OpenCodeCheckpointManifest> {
  try {
    await checkpoint(layout.liveDbPath, openCodeSessionId);
    const target = attemptDir(layout, { sessionId: layout.sessionId, taskId: layout.taskId });
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    const temp = join(target, `.${DB_FILE}.tmp`);
    await copyFile(layout.liveDbPath, temp);
    await fsyncPath(temp);
    await rename(temp, join(target, DB_FILE));
    await fsyncPath(target);
    await fsyncPath(join(target, '..'));
    const { digest, bytes } = await digestFile(join(target, DB_FILE));
    if (bytes <= 0) throw new OpenCodeNativeStateError('OpenCode checkpoint database is empty');
    return {
      version: 1,
      taskId: layout.taskId,
      digest,
      bytes,
      openCodeSessionId,
      openCodeVersion: OPENCODE_VERSION,
    };
  } catch (error) {
    if (error instanceof OpenCodeNativeStateError) throw error;
    throw new OpenCodeNativeStateError(
      `OpenCode checkpoint not durable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Remove exactly the attempts the ledger listed; returns those that are now gone. */
export async function removeOpenCodeCheckpoints(
  layout: OpenCodeNativeStateLayout,
  objects: readonly OpenCodeCheckpointObject[]
): Promise<OpenCodeCheckpointObject[]> {
  const removed: OpenCodeCheckpointObject[] = [];
  for (const object of objects) {
    try {
      // Parents stay: removing them could race another Session's exclusive seal.
      await rm(attemptDir(layout, object), { recursive: true, force: true });
      removed.push(object);
    } catch {
      // Left for a later turn to retry.
    }
  }
  return removed;
}
