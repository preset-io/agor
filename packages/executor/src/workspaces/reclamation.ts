import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BranchWorkspaceCoordinator } from '@agor/core/workspaces';
import type { WorkspaceBlobs } from '@agor/core/workspaces/types';
import type { Resident } from './placement.js';
import { snapshotReplicas } from './recovery.js';

/** Caller holds the worker admission gate and has verified physical executor quiescence. */
export async function reclaimWorkspace(
  c: BranchWorkspaceCoordinator,
  entry: Resident,
  recoveryBlobs: WorkspaceBlobs = c.blobs
): Promise<void> {
  const before = await c.metadata.read();
  if (!before.state) throw new Error('Unrecognized workspace');
  const staleCopy = !!before.state.host && before.state.host !== c.options.host;
  if (!staleCopy && Object.keys(before.state.active).length) throw new Error('Active workspace');
  if (Object.values(before.state.receipts).some((r) => r.outcome.status === 'conflict'))
    throw new Error('Unresolved conflict pins workspace');
  if (!staleCopy) await c.materialise(undefined, undefined, false);
  let renewalError: unknown;
  const renewal = staleCopy
    ? undefined
    : setInterval(
        () => {
          void c.renew().catch((e) => {
            renewalError = e;
          });
        },
        Math.max(10, c.options.leaseMs / 3)
      );
  try {
    const replicas = path.join(c.directory, 'replicas');
    let recovery: string | undefined;
    try {
      const st = await lstat(replicas);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Invalid replica directory');
      recovery = await snapshotReplicas(replicas, c.scope, recoveryBlobs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (renewalError) throw renewalError;
    await c.metadata.mutate((state, now) => {
      if (
        !state ||
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
          epoch: entry.epoch ?? 0,
        };
        state.localRecoveries ??= {};
        state.localRecoveries[recovery] = checkpoint;
        if (!staleCopy) state.localRecovery = checkpoint;
      }
      return { state, result: undefined };
    });
    if (!staleCopy) await c.drain();
    // Atomic detachment under the local admission gate. Late rm only sees this UUID,
    // never a recreated branch path. Recovery was acknowledged before detachment.
    const trash = path.join(c.options.root, 'eviction-trash', randomUUID());
    await mkdir(path.dirname(trash), { recursive: true, mode: 0o700 });
    await rename(c.directory, trash);
    entry.resident = false;
    entry.sessions = [];
    entry.generation = randomUUID();
    await rm(trash, { recursive: true, force: true });
  } finally {
    if (renewal) clearInterval(renewal);
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
