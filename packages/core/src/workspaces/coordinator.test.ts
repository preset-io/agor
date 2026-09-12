import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BranchID, TenantID } from '../types';
import { BranchWorkspaceCoordinator } from './coordinator';
import { LocalWorkspaceBlobs } from './local-blobs';
import { hash, scan } from './tree';
import type { WorkspaceMetadata, WorkspaceOptions, WorkspaceState } from './types';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
class Authority implements WorkspaceMetadata {
  state: WorkspaceState | null = null;
  now = 1000;
  failAfterCommit = false;
  async read() {
    return { state: structuredClone(this.state), now: this.now };
  }
  async mutate<T>(
    work: (s: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
  ): Promise<T> {
    const result = work(structuredClone(this.state), this.now);
    this.state = structuredClone(result.state);
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error('lost acknowledgement');
    }
    return structuredClone(result.result);
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agor-workspace-'));
  dirs.push(root);
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'a'), 'a0');
  await writeFile(path.join(source, 'b'), 'b0');
  const scope = { tenantId: 'tenant-a' as TenantID, branchId: 'branch-a' as BranchID };
  const metadata = new Authority();
  const blobs = new LocalWorkspaceBlobs(path.join(root, 'objects'), scope.tenantId);
  const options: WorkspaceOptions = {
    root: path.join(root, 'host-a'),
    host: 'a',
    leaseMs: 1000,
    toolLeaseMs: 500,
    clone: 'copy',
    maximumBytes: 10_000_000,
    maximumFiles: 1000,
    minimumFreeBytes: 0,
    minimumFreeInodes: 0,
    maximumActiveTools: 8,
    maximumReceipts: 1000,
    exclude: [],
  };
  const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, options);
  await c.materialise(source);
  return { root, source, scope, metadata, blobs, options, c };
}
describe('branch tool-boundary protocol', () => {
  it('commits disjoint concurrent changes and refreshes without notifications', async () => {
    const { c, metadata } = await fixture();
    const a = await c.beginTool('one', 't1', 'k1');
    const b = await c.beginTool('two', 't2', 'k2');
    expect([a.ticket.baseRevision, b.ticket.baseRevision]).toEqual([0, 0]);
    await writeFile(path.join(a.workspace, 'a'), 'a1');
    await writeFile(path.join(b.workspace, 'b'), 'b1');
    const outcomes = await Promise.all([c.completeTool(a.ticket), c.completeTool(b.ticket)]);
    expect(outcomes.map((o) => o.status)).toEqual(['committed', 'committed']);
    expect(metadata.state?.revision).toBe(2);
    expect(await readFile(path.join(a.workspace, 'b'), 'utf8')).toBe('b0');
    const next = await c.beginTool('one', 't3', 'k3');
    expect(next.ticket.baseRevision).toBe(2);
    expect(await readFile(path.join(next.workspace, 'b'), 'utf8')).toBe('b1');
  });
  it('rejects conflicting multi-file mutations atomically, with hashes and idempotency', async () => {
    const { c, metadata } = await fixture();
    const a = await c.beginTool('one', 't1', 'k1');
    const b = await c.beginTool('two', 't2', 'k2');
    await writeFile(path.join(a.workspace, 'a'), 'winner');
    await writeFile(path.join(b.workspace, 'a'), 'loser');
    await writeFile(path.join(b.workspace, 'b'), 'must-not-commit');
    await c.completeTool(a.ticket);
    const result = await c.completeTool(b.ticket);
    expect(result).toMatchObject({
      status: 'conflict',
      baseRevision: 0,
      currentRevision: 1,
      executorId: 'two',
      toolId: 't2',
      paths: [
        {
          path: 'a',
          baseHash: hash('a0'),
          currentHash: hash('winner'),
          proposedHash: hash('loser'),
        },
      ],
    });
    expect(metadata.state?.tree.b.hash).toBe(hash('b0'));
    expect(await c.completeTool(b.ticket)).toEqual(result);
  });
  it('returns the original outcome after a lost commit acknowledgement', async () => {
    const { c, metadata } = await fixture();
    const a = await c.beginTool('one', 't1', 'k1');
    await writeFile(path.join(a.workspace, 'a'), 'changed');
    metadata.failAfterCommit = true;
    await expect(c.completeTool(a.ticket)).rejects.toThrow('lost acknowledgement');
    expect(await c.completeTool(a.ticket)).toEqual({ status: 'committed', revision: 1 });
    expect(metadata.state?.revision).toBe(1);
  });
  it('fences stale hosts and restores post-checkpoint revisions after abrupt loss', async () => {
    const f = await fixture();
    await f.c.checkpoint();
    const a = await f.c.beginTool('one', 't1', 'k1');
    await writeFile(path.join(a.workspace, 'a'), 'durable');
    await f.c.completeTool(a.ticket);
    const stale = await f.c.beginTool('two', 't2', 'k2');
    await writeFile(path.join(stale.workspace, 'b'), 'not-durable');
    f.metadata.now += 2000;
    const b = new BranchWorkspaceCoordinator(f.scope, f.metadata, f.blobs, {
      ...f.options,
      host: 'b',
      root: path.join(f.root, 'host-b'),
    });
    expect(await b.restore()).toBe(1);
    await expect(f.c.completeTool(stale.ticket)).rejects.toMatchObject({ code: 'FENCED' });
    const next = await b.beginTool('three', 't3', 'k3');
    expect(await readFile(path.join(next.workspace, 'a'), 'utf8')).toBe('durable');
    expect(await readFile(path.join(next.workspace, 'b'), 'utf8')).toBe('b0');
  });
  it('migrates modes, symlinks, renames and empty directories', async () => {
    const f = await fixture();
    const a = await f.c.beginTool('one', 't1', 'k1');
    await rename(path.join(a.workspace, 'a'), path.join(a.workspace, 'renamed'));
    await chmod(path.join(a.workspace, 'renamed'), 0o755);
    await symlink('renamed', path.join(a.workspace, 'link'));
    await mkdir(path.join(a.workspace, 'empty'));
    await f.c.completeTool(a.ticket);
    const expected = f.metadata.state!.tree;
    await f.c.drain();
    await f.c.evict();
    const b = new BranchWorkspaceCoordinator(f.scope, f.metadata, f.blobs, {
      ...f.options,
      host: 'b',
      root: path.join(f.root, 'host-b'),
    });
    await b.restore();
    const next = await b.beginTool('two', 't2', 'k2');
    expect((await scan(next.workspace, [], f.options)).tree).toEqual(expected);
    expect((await lstat(path.join(next.workspace, 'renamed'))).mode & 0o777).toBe(0o755);
  });
  it('excludes nested dependencies, build products and credentials', async () => {
    const f = await fixture();
    const a = await f.c.beginTool('one', 't1', 'k1');
    for (const dir of ['node_modules/private', 'src/dist', '.aws', '.codex']) {
      await mkdir(path.join(a.workspace, dir), { recursive: true });
      await writeFile(path.join(a.workspace, dir, 'secret'), 'private');
    }
    await writeFile(path.join(a.workspace, '.env'), 'secret');
    await writeFile(path.join(a.workspace, '.npmrc'), 'secret');
    await f.c.completeTool(a.ticket);
    await f.c.checkpoint();
    expect(Object.keys(f.metadata.state!.tree).sort()).toEqual(['a', 'b', 'src']);
  });
  it('rejects symlink escapes and detects rename/edit, rename/rename and delete/edit', async () => {
    const f = await fixture();
    const a = await f.c.beginTool('one', 't1', 'k1');
    await symlink('/etc/passwd', path.join(a.workspace, 'escape'));
    await expect(f.c.completeTool(a.ticket)).rejects.toMatchObject({ code: 'INVALID' });
    expect(f.metadata.state?.revision).toBe(0);
    for (const mode of ['edit', 'rename', 'delete']) {
      const g = await fixture();
      const x = await g.c.beginTool('one', 't1', 'k1');
      const y = await g.c.beginTool('two', 't2', 'k2');
      await rename(path.join(x.workspace, 'a'), path.join(x.workspace, 'new-a'));
      if (mode === 'edit') await writeFile(path.join(y.workspace, 'a'), 'edit');
      if (mode === 'rename')
        await rename(path.join(y.workspace, 'a'), path.join(y.workspace, 'new-b'));
      if (mode === 'delete') await rm(path.join(y.workspace, 'a'));
      await g.c.completeTool(x.ticket);
      expect(await g.c.completeTool(y.ticket)).toMatchObject({ status: 'conflict' });
    }
  });
  it('never publishes interrupted uploads or runs corrupted checkpoints', async () => {
    const f = await fixture();
    const a = await f.c.beginTool('one', 't1', 'k1');
    await writeFile(path.join(a.workspace, 'a'), 'new');
    const original = f.blobs.put.bind(f.blobs);
    f.blobs.put = async () => {
      throw new Error('S3 interrupted');
    };
    await expect(f.c.completeTool(a.ticket)).rejects.toThrow('S3 interrupted');
    expect(f.metadata.state?.revision).toBe(0);
    f.blobs.put = original;
    await f.c.abortTool(a.ticket);
    const cp = await f.c.checkpoint();
    await writeFile(path.join(f.blobs.directory, cp.hash), 'corrupt');
    await expect(f.c.restore()).rejects.toThrow();
  });
  it('prevents tenant confusion, active migration and capacity overruns', async () => {
    const f = await fixture();
    const other = new BranchWorkspaceCoordinator(
      { ...f.scope, tenantId: 'other' as TenantID },
      f.metadata,
      f.blobs,
      f.options
    );
    await expect(other.restore()).rejects.toMatchObject({ code: 'INVALID' });
    const a = await f.c.beginTool('one', 't1', 'k1');
    await expect(f.c.drain()).rejects.toMatchObject({ code: 'BUSY' });
    await expect(f.c.beginTool('one', 't2', 'k2')).rejects.toMatchObject({ code: 'BUSY' });
    await f.c.abortTool(a.ticket);
    const full = new BranchWorkspaceCoordinator(f.scope, f.metadata, f.blobs, {
      ...f.options,
      minimumFreeInodes: Number.MAX_SAFE_INTEGER,
    });
    await expect(full.materialise()).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(await f.c.beginTool('one', 't2', 'k2')).toHaveProperty('workspace');
  });
  it('serializes eight writers without missing or duplicated revisions', async () => {
    const f = await fixture();
    const tools = await Promise.all(
      Array.from({ length: 8 }, (_, i) => f.c.beginTool(`e${i}`, `t${i}`, `k${i}`))
    );
    await Promise.all(
      tools.map(async (t, i) => {
        await writeFile(path.join(t.workspace, `file-${i}`), String(i));
        return f.c.completeTool(t.ticket);
      })
    );
    expect(f.metadata.state?.revision).toBe(8);
    expect(Object.keys(f.metadata.state!.receipts)).toHaveLength(8);
    for (let i = 0; i < 8; i++)
      expect(f.metadata.state!.tree[`file-${i}`].hash).toBe(hash(String(i)));
  });
  it('fences released executor identities and rebuilds an interrupted idle refresh', async () => {
    const f = await fixture();
    const old = await f.c.beginTool('one', 'old', 'old');
    await f.c.completeTool(old.ticket);
    const writer = await f.c.beginTool('two', 'writer', 'writer');
    await writeFile(path.join(writer.workspace, 'a'), 'a-new');
    await writeFile(path.join(writer.workspace, 'b'), 'b-new');
    await f.c.completeTool(writer.ticket);
    const get = f.blobs.get.bind(f.blobs);
    f.blobs.get = async (key) => {
      if (key === hash('b-new')) throw new Error('interrupted refresh');
      return get(key);
    };
    await expect(f.c.beginTool('one', 'failed', 'failed')).rejects.toThrow('interrupted refresh');
    f.blobs.get = get;
    const next = await f.c.beginTool('one', 'recovered', 'recovered');
    expect(await readFile(path.join(next.workspace, 'a'), 'utf8')).toBe('a-new');
    expect(await readFile(path.join(next.workspace, 'b'), 'utf8')).toBe('b-new');
    await f.c.abortTool(next.ticket);
    await f.c.releaseReplica('one');
    await expect(f.c.beginTool('one', 'reused', 'reused')).rejects.toMatchObject({
      code: 'FENCED',
    });
  });
  it('reaps crashed tool reservations before inactivity maintenance', async () => {
    const f = await fixture();
    await f.c.beginTool('one', 'crashed', 'crashed');
    f.metadata.now += 501;
    await f.c.reapExpiredTools();
    expect(Object.keys(f.metadata.state!.active)).toHaveLength(0);
    await expect(f.c.checkpoint()).resolves.toHaveProperty('revision', 0);
  });
});

it('renews ownership while a cold restore exceeds the original lease', async () => {
  const { metadata, blobs, scope, options } = await fixture();
  metadata.now = Date.now();
  metadata.state!.leaseUntil = 0;
  const originalMutate = metadata.mutate.bind(metadata);
  metadata.mutate = async (work) => {
    metadata.now = Date.now();
    return originalMutate(work);
  };
  const recovering = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    {
      put: blobs.put.bind(blobs),
      get: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return blobs.get(key);
      },
    },
    { ...options, root: `${options.root}-cold`, host: 'cold', leaseMs: 60 }
  );
  await recovering.materialise();
  const tool = await recovering.beginTool('recovered', 'tool', 'key');
  expect(tool.ticket.baseRevision).toBe(0);
  await recovering.abortTool(tool.ticket);
});
it('does not publish initial metadata after import cancellation', async () => {
  const { source, scope, options, blobs } = await fixture();
  const metadata = new Authority();
  const abort = new AbortController();
  const cancelled = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    {
      put: async (key, bytes) => {
        await blobs.put(key, bytes);
        abort.abort();
      },
      get: blobs.get.bind(blobs),
    },
    { ...options, root: `${options.root}-cancelled` }
  );
  await expect(cancelled.materialise(source, abort.signal)).rejects.toThrow();
  expect(metadata.state).toBeNull();
});

it('reuses the rendered base after PostgreSQL JSONB reorders manifest keys', async () => {
  const { source, scope, options, blobs } = await fixture();
  const metadata = new Authority();
  let downloads = 0;
  const c = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    {
      put: blobs.put.bind(blobs),
      get: async (key) => {
        downloads++;
        return blobs.get(key);
      },
    },
    { ...options, root: `${options.root}-jsonb` }
  );
  await c.materialise(source);
  const initialDownloads = downloads;
  metadata.state!.tree = Object.fromEntries(
    Object.entries(metadata.state!.tree)
      .reverse()
      .map(([name, entry]) => [name, Object.fromEntries(Object.entries(entry).reverse())])
  ) as WorkspaceState['tree'];
  const next = await c.beginTool('one', 'tool', 'key');
  expect(downloads).toBe(initialDownloads);
  await c.abortTool(next.ticket);
});

it('retains nested local packages, environments and Git state after a tool abort and source refresh', async () => {
  const { c, metadata } = await fixture();
  const a = await c.beginTool('session-a', 'first', 'first');
  await mkdir(path.join(a.workspace, 'frontend'));
  await writeFile(path.join(a.workspace, 'frontend/package.json'), '{}');
  await c.completeTool(a.ticket);
  const b = await c.beginTool('session-a', 'install', 'install');
  for (const directory of [
    'frontend/node_modules/pkg',
    '.venv/lib/pkg',
    '.git/refs/heads',
    '.cache/pip',
  ]) {
    await mkdir(path.join(b.workspace, directory), { recursive: true });
    await writeFile(path.join(b.workspace, directory, 'local'), 'retained');
  }
  await writeFile(path.join(b.workspace, 'a'), 'uncommitted crash');
  await c.abortTool(b.ticket);
  const next = await c.beginTool('session-a', 'next-prompt', 'next-prompt');
  expect(await readFile(path.join(next.workspace, 'a'), 'utf8')).toBe('a0');
  for (const directory of [
    'frontend/node_modules/pkg',
    '.venv/lib/pkg',
    '.git/refs/heads',
    '.cache/pip',
  ])
    expect(await readFile(path.join(next.workspace, directory, 'local'), 'utf8')).toBe('retained');
  await c.completeTool(next.ticket);
  expect(
    Object.keys(metadata.state!.tree).some((name) => /node_modules|\.venv|\.git|\.cache/.test(name))
  ).toBe(false);
  const other = await c.beginTool('session-b', 'other', 'other');
  await expect(lstat(path.join(other.workspace, '.venv'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await c.abortTool(other.ticket);
});
