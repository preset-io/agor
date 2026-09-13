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
  it('packs thousands of small files, bounds transfers, and reuses acknowledged packs', async () => {
    const { root, source, blobs } = await fixture();
    await mkdir(path.join(source, 'session'));
    for (let i = 0; i < 1024; i++)
      await writeFile(path.join(source, 'session', String(i)), `value-${i}`);
    let puts = 0,
      active = 0,
      maximum = 0;
    const store = {
      get: blobs.get.bind(blobs),
      put: async (key: string, bytes: Buffer) => {
        puts++;
        active++;
        maximum = Math.max(maximum, active);
        try {
          await new Promise((r) => setTimeout(r, 2));
          await blobs.put(key, bytes);
        } finally {
          active--;
        }
      },
    };
    const options = { journal: path.join(root, 'receipts') };
    const first = await snapshotReplicas(source, scope, store, options);
    expect(puts).toBeLessThanOrEqual(65);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    puts = 0;
    expect(await snapshotReplicas(source, scope, store, options)).toBe(first);
    expect(puts).toBe(0);
    await writeFile(path.join(source, 'session/7'), 'changed');
    const changed = await snapshotReplicas(source, scope, store, options);
    expect(puts).toBe(2); // one path shard and its manifest
    const target = path.join(root, 'restored');
    await restoreReplicas(target, scope, changed, store);
    expect(await readFile(path.join(target, 'session/7'), 'utf8')).toBe('changed');
    expect(await readFile(path.join(target, 'session/1023'), 'utf8')).toBe('value-1023');
  }, 30000);
  it('restores files spanning packs and rejects corrupt packed ranges atomically', async () => {
    const { root, source, blobs } = await fixture();
    const content = Buffer.alloc(33 * 1024 ** 2, 91);
    await writeFile(path.join(source, 'large'), content);
    const digest = await snapshotReplicas(source, scope, blobs);
    await restoreReplicas(path.join(root, 'large-restored'), scope, digest, blobs);
    expect((await readFile(path.join(root, 'large-restored/large'))).equals(content)).toBe(true);
    const manifest = JSON.parse((await blobs.get(digest)).toString());
    manifest.entries[0].parts[0].offset = 32 * 1024 ** 2;
    const invalid = Buffer.from(JSON.stringify(manifest));
    await blobs.put(hash(invalid), invalid);
    await expect(
      restoreReplicas(path.join(root, 'bad'), scope, hash(invalid), blobs)
    ).rejects.toThrow('outside pack');
    await expect(readFile(path.join(root, 'bad/large'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);
  it('continues to read v1 recovery manifests', async () => {
    const { root, blobs } = await fixture();
    const content = Buffer.from('legacy');
    await blobs.put(hash(content), content);
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        ...scope,
        entries: [
          { path: 'file', kind: 'file', mode: 0o600, uid: 0, gid: 0, parts: [hash(content)] },
        ],
      })
    );
    await blobs.put(hash(bytes), bytes);
    await restoreReplicas(path.join(root, 'legacy'), scope, hash(bytes), blobs);
    expect(await readFile(path.join(root, 'legacy/file'), 'utf8')).toBe('legacy');
  });
  it('resumes acknowledged packs after a partial upload failure', async () => {
    const { root, source, blobs } = await fixture();
    for (let i = 0; i < 100; i++) await writeFile(path.join(source, String(i)), String(i));
    const good = new Set<string>();
    let attempts = 0;
    const journal = path.join(root, 'resume');
    await expect(
      snapshotReplicas(
        source,
        scope,
        {
          get: blobs.get.bind(blobs),
          put: async (key, bytes) => {
            if (++attempts > 8) throw new Error('interrupted');
            await blobs.put(key, bytes);
            good.add(key);
          },
        },
        { journal }
      )
    ).rejects.toThrow('interrupted');
    expect(good.size).toBeGreaterThan(0);
    await snapshotReplicas(
      source,
      scope,
      {
        get: blobs.get.bind(blobs),
        put: async (key, bytes) => {
          expect(good.has(key)).toBe(false);
          await blobs.put(key, bytes);
        },
      },
      { journal }
    );
  });
});
