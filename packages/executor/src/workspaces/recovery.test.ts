import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BranchID, TenantID } from '@agor/core/types';
import { hash, LocalWorkspaceBlobs } from '@agor/core/workspaces';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreReplicas, snapshotReplicas } from './recovery';

const scope = { tenantId: 'tenant' as TenantID, branchId: 'branch' as BranchID };
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'replica-recovery-'));
  roots.push(root);
  const source = path.join(root, 'replicas');
  await mkdir(source);
  return { root, source, blobs: new LocalWorkspaceBlobs(path.join(root, 'blobs'), scope.tenantId) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('private local-state recovery', () => {
  it('round-trips Git, excluded dependencies, homes, empty files and symlinks', async () => {
    const { root, source, blobs } = await fixture();
    for (const name of ['s/workspace/.git', 's/workspace/node_modules', 's/local-home/.local'])
      await mkdir(path.join(source, name), { recursive: true });
    await writeFile(path.join(source, 's/workspace/.git/index'), 'staged changes');
    await writeFile(path.join(source, 's/local-home/.local/private'), 'private local data');
    await writeFile(path.join(source, 's/workspace/node_modules/test'), 'dependency');
    await writeFile(path.join(source, 's/replica-tree.json'), '{}');
    await writeFile(path.join(source, 's/empty'), '');
    await symlink('../outside', path.join(source, 's/link'));
    const manifest = await snapshotReplicas(source, scope, blobs);
    const target = path.join(root, 'restored');
    await restoreReplicas(target, scope, manifest, blobs);
    expect(await readFile(path.join(target, 's/workspace/.git/index'), 'utf8')).toBe(
      'staged changes'
    );
    expect(await readFile(path.join(target, 's/local-home/.local/private'), 'utf8')).toBe(
      'private local data'
    );
    expect(await readFile(path.join(target, 's/workspace/node_modules/test'), 'utf8')).toBe(
      'dependency'
    );
    expect(await readlink(path.join(target, 's/link'))).toBe('../outside');
  });
  it('rejects tenant crossing and symlink-ancestor archive attacks', async () => {
    const { root, source, blobs } = await fixture();
    const manifest = await snapshotReplicas(source, scope, blobs);
    await expect(
      restoreReplicas(
        path.join(root, 'wrong'),
        { ...scope, tenantId: 'other' as TenantID },
        manifest,
        blobs
      )
    ).rejects.toThrow('scope');
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        ...scope,
        entries: [
          { path: 'escape', kind: 'symlink', target: '/tmp', mode: 0, uid: 0, gid: 0 },
          { path: 'escape/file', kind: 'file', parts: [], mode: 0, uid: 0, gid: 0 },
        ],
      })
    );
    await blobs.put(hash(bytes), bytes);
    await expect(
      restoreReplicas(path.join(root, 'attack'), scope, hash(bytes), blobs)
    ).rejects.toThrow('ancestor');
  });
  it('keeps the original replica when an upload fails', async () => {
    const { source, blobs } = await fixture();
    await writeFile(path.join(source, 'file'), 'important');
    await expect(
      snapshotReplicas(source, scope, {
        get: blobs.get.bind(blobs),
        put: async () => {
          throw new Error('S3 down');
        },
      })
    ).rejects.toThrow('S3 down');
    expect(await readFile(path.join(source, 'file'), 'utf8')).toBe('important');
  });
  it('cancels a restore without exposing a partially restored session', async () => {
    const { root, source, blobs } = await fixture();
    await mkdir(path.join(source, 'session'));
    await writeFile(path.join(source, 'session/file'), 'private');
    const digest = await snapshotReplicas(source, scope, blobs);
    const controller = new AbortController();
    const target = path.join(root, 'cancelled');
    const store = {
      put: blobs.put.bind(blobs),
      get: async (key: string) => {
        const bytes = await blobs.get(key);
        if (key !== digest) controller.abort(new Error('Task stopped'));
        return bytes;
      },
    };
    await expect(
      restoreReplicas(target, scope, digest, store, 'session', controller.signal)
    ).rejects.toThrow('Task stopped');
    await expect(readFile(path.join(target, 'session/file'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
