import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BranchID, TenantID } from '@agor/core/types';
import { BranchWorkspaceCoordinator, LocalWorkspaceBlobs } from '@agor/core/workspaces';
import type { WorkspaceMetadata, WorkspaceState } from '@agor/core/workspaces/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { Resident } from './placement';
import { reclaimBlobCache, reclaimWorkspace } from './reclamation';
import { restoreReplicas } from './recovery';

const roots: string[] = [];
class Authority implements WorkspaceMetadata {
  state: WorkspaceState | null = null;
  now = 1000;
  async read() {
    return { state: structuredClone(this.state), now: this.now };
  }
  async mutate<T>(
    work: (state: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
  ) {
    const next = work(structuredClone(this.state), this.now);
    this.state = structuredClone(next.state);
    return structuredClone(next.result);
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'reclaim-'));
  roots.push(root);
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'file'), 'source');
  const scope = { tenantId: 'tenant' as TenantID, branchId: 'branch' as BranchID };
  const metadata = new Authority();
  const blobs = new LocalWorkspaceBlobs(path.join(root, 'blobs'), scope.tenantId);
  const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, {
    root: path.join(root, 'worker'),
    host: 'one',
    clone: 'copy',
    leaseMs: 60000,
    toolLeaseMs: 60000,
    maximumBytes: 1000000,
    maximumFiles: 10000,
    minimumFreeBytes: 0,
    minimumFreeInodes: 0,
    maximumActiveTools: 8,
    maximumReceipts: 100,
    exclude: [],
  });
  await c.materialise(source);
  const tool = await c.beginTool('session', 'tool', 'key');
  await c.completeTool(tool.ticket);
  const entry: Resident = {
    branchId: 'branch',
    repository: 'repo',
    sessions: ['session'],
    resident: true,
    revision: 0,
    lastUsed: 0,
    generation: 'old',
    preparationMs: 1,
  };
  return { root, c, metadata, blobs, entry };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('fenced workspace reclamation', () => {
  it('preserves excluded private state durably before eviction and restores it for a new tool', async () => {
    const f = await fixture();
    await mkdir(path.join(f.c.replicaPath('session'), '.git'));
    await writeFile(path.join(f.c.replicaPath('session'), '.git/index'), 'unpublished index');
    await reclaimWorkspace(f.c, f.entry);
    expect(f.entry.resident).toBe(false);
    await expect(lstat(f.c.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.metadata.state!.localRecovery).toBeDefined();
    const restored = new BranchWorkspaceCoordinator(f.c.scope, f.metadata, f.blobs, {
      ...f.c.options,
      host: 'two',
      root: path.join(f.root, 'worker-two'),
    });
    await mkdir(restored.directory, { recursive: true });
    await restoreReplicas(
      path.join(restored.directory, 'replicas'),
      f.c.scope,
      f.metadata.state!.localRecovery!.hash,
      f.blobs,
      'session'
    );
    await restored.materialise();
    const tool = await restored.beginTool('session', 'next', 'next');
    expect(await readFile(path.join(tool.workspace, '.git/index'), 'utf8')).toBe(
      'unpublished index'
    );
    await restored.abortTool(tool.ticket);
  });
  it('does not evict an active tool; reclaims stale local copies without changing another owner', async () => {
    const f = await fixture();
    const tool = await f.c.beginTool('busy', 'busy', 'busy');
    await expect(reclaimWorkspace(f.c, f.entry)).rejects.toThrow('Active');
    await f.c.abortTool(tool.ticket);
    f.metadata.state!.host = 'other';
    const epoch = f.metadata.state!.epoch;
    await reclaimWorkspace(f.c, f.entry);
    expect(f.metadata.state!.host).toBe('other');
    expect(f.metadata.state!.epoch).toBe(epoch);
    expect(f.entry.resident).toBe(false);
  });
  it('keeps the generation when S3 fails and rejects conflict receipts', async () => {
    const f = await fixture();
    await expect(
      reclaimWorkspace(f.c, f.entry, {
        get: f.blobs.get.bind(f.blobs),
        put: async () => {
          throw new Error('offline');
        },
      })
    ).rejects.toThrow('offline');
    expect(await readFile(path.join(f.c.replicaPath('session'), 'file'), 'utf8')).toBe('source');
    const a = await f.c.beginTool('a', 'a', 'a'),
      b = await f.c.beginTool('b', 'b', 'b');
    await writeFile(path.join(a.workspace, 'file'), 'a');
    await writeFile(path.join(b.workspace, 'file'), 'b');
    await f.c.completeTool(a.ticket);
    await f.c.completeTool(b.ticket);
    await expect(reclaimWorkspace(f.c, f.entry)).rejects.toThrow('conflict');
  });
  it('reclaims only hash-named blobs and stops after pressure clears', async () => {
    const f = await fixture(),
      cache = path.join(f.root, 'cache');
    await mkdir(cache);
    for (let i = 0; i < 70; i++)
      await writeFile(path.join(cache, i.toString(16).padStart(64, '0')), 'cache');
    await writeFile(path.join(cache, 'private'), 'keep');
    let checks = 0;
    expect(await reclaimBlobCache(cache, async () => ++checks > 1)).toBe(32);
    expect(await readFile(path.join(cache, 'private'), 'utf8')).toBe('keep');
  });
});
