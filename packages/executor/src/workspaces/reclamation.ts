import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BranchWorkspaceCoordinator } from '@agor/core/workspaces';
import type { WorkspaceBlobs } from '@agor/core/workspaces/types';
import type { Resident } from './placement.js';
import { snapshotReplicas } from './recovery.js';

export interface CompletedRecovery {
  hash: string;
  revision: number;
  epoch: number;
}
export interface ReclamationOptions {
  reuse?: CompletedRecovery;
  /** A synchronous, tenant/branch-scoped lock; the caller tracks dispatches AND reads. */
  lock?: () => (() => void) | undefined;
  version?: () => number;
  journal?: string;
  checkpointOnly?: boolean;
  signal?: AbortSignal;
}
/** Caller verifies physical executor containment. Only snapshot capture and final detach
 * hold branch admission; immutable upload runs without a worker-wide gate. */
export async function reclaimWorkspace(
  c: BranchWorkspaceCoordinator,
  entry: Resident,
  recoveryBlobs: WorkspaceBlobs = c.blobs,
  options: ReclamationOptions = {}
): Promise<CompletedRecovery | undefined> {
  let unlock = options.lock ? options.lock() : () => {};
  if (!unlock) throw new Error('Branch active during checkpoint');
  const version = options.version?.();
  const generation = entry.generation;
  const snapshot = path.join(
    c.options.root,
    'recovery-snapshots',
    c.scope.tenantId,
    c.scope.branchId,
    randomUUID()
  );
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    const before = await c.metadata.read();
    if (!before.state) throw new Error('Unrecognized workspace');
    const staleCopy = !!before.state.host && before.state.host !== c.options.host;
    if (!staleCopy && Object.keys(before.state.active).length) throw new Error('Active workspace');
    if (Object.values(before.state.receipts).some((r) => r.outcome.status === 'conflict'))
      throw new Error('Unresolved conflict pins workspace');
    if (!staleCopy) await c.materialise(undefined, undefined, false);
    const captured = (await c.metadata.read()).state!;
    let renewalError: unknown;
    renewal = staleCopy
      ? undefined
      : setInterval(
          () => {
            void c.renew().catch((e) => {
              renewalError = e;
            });
          },
          Math.max(10, c.options.leaseMs / 3)
        );
    const replicas = path.join(c.directory, 'replicas');
    const reuse = options.reuse;
    let recovery =
      reuse &&
      before.state.revision === reuse.revision &&
      before.state.epoch === reuse.epoch &&
      before.state.localRecoveries?.[reuse.hash]
        ? reuse.hash
        : undefined;
    const st = await lstat(replicas).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (st && !recovery) {
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Invalid replica directory');
      await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      // cp -a preserves ownership and links. FORCE reflinks on the production XFS path.
      await promisify(execFile)(
        'cp',
        ['-a', ...(c.options.clone === 'reflink' ? ['--reflink=always'] : []), replicas, snapshot],
        { signal: options.signal }
      );
      unlock();
      unlock = undefined;
      recovery = await snapshotReplicas(snapshot, c.scope, recoveryBlobs, options);
    }
    if (renewalError) throw renewalError;
    if (!unlock) unlock = options.lock ? options.lock() : () => {};
    if (!unlock || options.version?.() !== version || entry.generation !== generation)
      throw new Error('Branch changed during checkpoint');
    options.signal?.throwIfAborted();
    await c.metadata.mutate((state, now) => {
      if (
        !state ||
        state.revision !== captured.revision ||
        state.epoch !== captured.epoch ||
        (!staleCopy &&
          (state.host !== c.options.host ||
            state.leaseUntil <= now ||
            Object.keys(state.active).length ||
            state.maintenance))
      )
        throw new Error('Eviction lost ownership');
      if (Object.values(state.receipts).some((r) => r.outcome.status === 'conflict'))
        throw new Error('Conflict pins workspace');
      if (recovery) {
        const checkpoint = {
          hash: recovery,
          revision: staleCopy ? (entry.revision ?? 0) : state.revision,
          origin: c.options.host.split('#')[0],
          createdAt: now,
          epoch: staleCopy ? (entry.epoch ?? 0) : captured.epoch,
        };
        state.localRecoveries ??= {};
        state.localRecoveries[recovery] = checkpoint;
        if (!staleCopy) state.localRecovery = checkpoint;
      }
      return { state, result: undefined };
    });
    if (!staleCopy) await c.drain();
    const completed = recovery
      ? { hash: recovery, revision: captured.revision, epoch: captured.epoch + (staleCopy ? 0 : 1) }
      : undefined;
    if (options.checkpointOnly) return completed;
    // Atomic detachment under the local admission gate. Late rm only sees this UUID,
    // never a recreated branch path. Recovery was acknowledged before detachment.
    const trash = path.join(c.options.root, 'eviction-trash', randomUUID());
    await mkdir(path.dirname(trash), { recursive: true, mode: 0o700 });
    await rename(c.directory, trash);
    entry.resident = false;
    entry.sessions = [];
    entry.generation = randomUUID();
    unlock();
    unlock = undefined;
    await rm(trash, { recursive: true, force: true });
    return completed;
  } finally {
    if (renewal) clearInterval(renewal);
    unlock?.();
    await rm(snapshot, { recursive: true, force: true });
  }
}

/** Only the dedicated S3 read cache is disposable; never walk SDK homes or repositories. */
export async function reclaimBlobCache(
  root: string,
  enough: () => Promise<boolean>,
  observe = false
): Promise<number> {
  let count = 0;
  async function walk(directory: string): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
    for (const name of names) {
      const file = path.join(directory, name),
        st = await lstat(file);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (await walk(file)) return true;
      } else if (st.isFile() && /^[a-f0-9]{64}$/.test(name)) {
        if (!observe) await rm(file);
        count++;
        if (count % 32 === 0 && (await enough())) return true;
      }
    }
    return false;
  }
  if (!(await enough())) await walk(root);
  return count;
}
