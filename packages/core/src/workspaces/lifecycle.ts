import path from 'node:path';
import {
  type BranchWorkspaceConfig,
  resolveBranchWorkspaceConfig,
  usesReplicatedWorkspace,
} from '../config/branch-workspace';
import { getManagedStorageSegments } from '../config/storage-layout';
import { BranchWorkspaceCoordinator } from './coordinator';
import { hash } from './tree';
import type {
  WorkspaceBlobs,
  WorkspaceMetadata,
  WorkspaceOptions,
  WorkspaceScope,
  WorkspaceState,
} from './types';
import { WorkspaceError } from './types';

/** Runtime rollout factory: omission leaves the existing branch storage backend in control. */
export function createBranchWorkspace(input: {
  scope: WorkspaceScope;
  config?: BranchWorkspaceConfig;
  metadata: WorkspaceMetadata;
  blobs: WorkspaceBlobs;
  host: string;
  observe?: WorkspaceOptions['observe'];
}): BranchWorkspaceCoordinator | undefined {
  if (!usesReplicatedWorkspace(input.config, input.scope.tenantId, input.scope.branchId))
    return undefined;
  const c = resolveBranchWorkspaceConfig(input.config);
  return new BranchWorkspaceCoordinator(input.scope, input.metadata, input.blobs, {
    root: c.local_root,
    host: input.host,
    clone: c.clone,
    exclude: c.exclude,
    leaseMs: c.lease_seconds * 1000,
    toolLeaseMs: c.tool_lease_seconds * 1000,
    maximumBytes: c.maximum_local_bytes,
    maximumFiles: c.maximum_local_inodes,
    minimumFreeBytes: c.minimum_free_bytes,
    minimumFreeInodes: c.minimum_free_inodes,
    maximumActiveTools: c.maximum_active_tools,
    maximumReceipts: c.maximum_receipts,
    observe: input.observe,
  });
}
export interface WorkerCapacity {
  host: string;
  healthy: boolean;
  freeBytes: number;
  freeInodes: number;
  freeCpu: number;
  freeMemoryBytes: number;
  freeExecutors: number;
}
export interface ExecutorDemand {
  bytes: number;
  inodes: number;
  cpu: number;
  memoryBytes: number;
  executors: number;
}
/** Selection is a hint; materialise's SQL lease acquisition is the authoritative fence. */
export function selectWorkspaceHost(
  state: WorkspaceState | null,
  now: number,
  workers: WorkerCapacity[],
  demand: ExecutorDemand
): { host: string; reason: 'affinity' | 'capacity' } {
  const fits = (w: WorkerCapacity) =>
    w.healthy &&
    w.freeBytes >= demand.bytes &&
    w.freeInodes >= demand.inodes &&
    w.freeCpu >= demand.cpu &&
    w.freeMemoryBytes >= demand.memoryBytes &&
    w.freeExecutors >= demand.executors;
  if (state?.host && state.leaseUntil > now) {
    const owner = workers.find((w) => w.host === state.host);
    if (!owner || !fits(owner))
      throw new WorkspaceError(
        'CAPACITY',
        'Active branch host is unavailable or lacks admission capacity; placement cannot move before fencing'
      );
    return { host: owner.host, reason: 'affinity' };
  }
  const next = workers
    .filter(fits)
    .sort((a, b) => b.freeExecutors - a.freeExecutors || b.freeBytes - a.freeBytes)[0];
  if (!next)
    throw new WorkspaceError(
      'CAPACITY',
      'No worker satisfies bytes, inodes, CPU, memory and executor demand'
    );
  return { host: next.host, reason: 'capacity' };
}
/** Called by the worker's existing maintenance/draining loop; does not create background processes. */
export async function maintainBranchWorkspace(
  coordinator: BranchWorkspaceCoordinator,
  idleSeconds: number,
  draining = false
): Promise<'busy' | 'checkpointed' | 'drained' | 'active'> {
  const ownership = await coordinator.metadata.read();
  if (
    ownership.state?.host === coordinator.options.host &&
    ownership.state.leaseUntil > ownership.now
  )
    await coordinator.reapExpiredTools();
  const { state, now } = await coordinator.metadata.read();
  if (!state || state.host !== coordinator.options.host) return 'active';
  if (Object.keys(state.active).length) return 'busy';
  if (draining) {
    await coordinator.drain();
    return 'drained';
  }
  if (now - state.updatedAt < idleSeconds * 1000) return 'active';
  if (state.checkpoint?.revision === state.revision) return 'checkpointed';
  await coordinator.checkpoint();
  return 'checkpointed';
}
/** No cross-tenant content deduplication. Callers must hash all manifests/configs that affect reuse. */
export function dependencyCachePath(
  root: string,
  scope: WorkspaceScope,
  inputs: {
    lockfileHash: string;
    manifestsHash: string;
    runtime: string;
    packageManager: string;
    platform: string;
    architecture: string;
    installFlags: string;
    registryConfigurationHash: string;
  }
): string {
  for (const value of Object.values(inputs))
    if (!value) throw new WorkspaceError('INVALID', 'Incomplete dependency cache identity');
  return path.join(
    root,
    ...getManagedStorageSegments('workspace-caches', {
      tenantId: scope.tenantId,
      tenantSeparated: true,
    }),
    hash(JSON.stringify(inputs))
  );
}

/** Offline mark phase. Caller must hold the existing tenant write gate and drain/fence ALL placements. */
export function workspaceBlobRoots(states: WorkspaceState[], now: number): Set<string> {
  const live = new Set<string>();
  for (const state of states) {
    if (state.host || state.leaseUntil > now || Object.keys(state.active).length)
      throw new WorkspaceError('BUSY', 'Content GC requires fully drained placements');
    for (const entry of Object.values(state.tree)) if (entry.kind === 'file') live.add(entry.hash);
    if (state.checkpoint) live.add(state.checkpoint.hash);
    // Recovery manifests reference chunk blobs. Offline GC must expand these roots
    // before sweeping; fail closed until the caller supports that graph.
    if (state.localRecovery || Object.keys(state.localRecoveries ?? {}).length)
      throw new WorkspaceError('BUSY', 'Recovery manifests require recursive blob marking');
    // Retained receipts are recovery/debug history and keep referenced versions alive.
    for (const receipt of Object.values(state.receipts))
      for (const mutation of receipt.mutations)
        for (const entry of [mutation.before, mutation.after])
          if (entry?.kind === 'file') live.add(entry.hash);
  }
  return live;
}
