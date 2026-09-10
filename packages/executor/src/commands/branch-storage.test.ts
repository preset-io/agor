import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BranchBundleReceipt } from '@agor/core/types';
import { simpleGit } from '@agor/git';
import { afterEach, expect, it, vi } from 'vitest';
import type { BranchStoragePayload } from '../payload-types.js';
import { handleBranchStorage } from './branch-storage.js';

const { get, disconnect } = vi.hoisted(() => ({ get: vi.fn(), disconnect: vi.fn() }));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: async () => ({ service: () => ({ get }), io: { disconnect } }),
}));
let dir: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  dir = await mkdtemp(join(tmpdir(), 'agor-storage-command-'));
  const origin = join(dir, 'origin');
  const root = join(dir, 'workspace');
  await mkdir(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.addConfig('user.name', 'Storage test');
  await git.addConfig('user.email', 'storage@example.invalid');
  await writeFile(join(origin, 'tracked'), 'committed');
  await git.add('.');
  await git.commit('fixture');
  await simpleGit().clone(origin, root, ['--no-hardlinks']);
  await writeFile(join(root, 'tracked'), 'staged');
  await simpleGit(root).add('tracked');
  await writeFile(join(root, 'tracked'), 'dirty');
  await writeFile(join(dir, 'sdk-home'), 'outside workspace');
  let bytes: Buffer;
  let receipt: BranchBundleReceipt;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      if (init.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
        bytes = Buffer.concat(chunks);
        receipt = {
          bucket: 'fixture',
          key: 'fixture',
          etag: 'etag',
          providerChecksum: 'provider',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        };
        return Response.json(receipt);
      }
      return new Response(new Uint8Array(bytes));
    })
  );
  const run = async (action: BranchStoragePayload['params']['action'], replacePartial = false) => {
    get.mockResolvedValue({
      path: root,
      workspace_storage: {
        operationId: 'operation',
        phase: { pack: 'packing', cleanup: 'cleanup', restore: 'restoring', publish: 'publishing' }[
          action
        ],
      },
    });
    return handleBranchStorage(
      {
        command: 'branch.storage',
        sessionToken: 'fixture-token',
        daemonUrl: 'https://fixture.invalid',
        params: {
          branchId: 'branch',
          operationId: 'operation',
          action,
          cwd: root,
          principalBranchAccess: 'write',
          digest: receipt,
          replacePartial,
        },
      } as BranchStoragePayload,
      {}
    );
  };
  return { root, run };
}

it('executes pack, cleanup, verified restore and publish on a disposable clone; SDK home stays local', async () => {
  const { root, run } = await fixture();
  const index = await readFile(join(root, '.git', 'index'));
  const before = await simpleGit(root).raw(['status', '--porcelain']);
  expect((await run('pack')).success).toBe(true);
  expect((await run('cleanup')).success).toBe(true);
  expect(await readdir(root)).toEqual([]);
  expect((await run('restore')).success).toBe(true);
  expect(await readdir(root)).toEqual(['.agor-cold-restore-operation']);
  expect((await run('publish')).success).toBe(true);
  expect(await readFile(join(root, '.git', 'index'))).toEqual(index);
  expect(await simpleGit(root).raw(['status', '--porcelain'])).toBe(before);
  expect(await readFile(join(dir, 'sdk-home'), 'utf8')).toBe('outside workspace');
});

it('refuses a partial workspace by default; explicit settled recovery verifies before replacing it', async () => {
  const { root, run } = await fixture();
  expect((await run('pack')).success).toBe(true);
  await rm(join(root, 'tracked'));
  await writeFile(join(root, 'partial'), 'interrupted cleanup');
  expect((await run('restore')).success).toBe(false);
  expect((await run('restore', true)).success).toBe(true);
  expect(await readFile(join(root, 'partial'), 'utf8')).toBe('interrupted cleanup');
  expect((await run('publish', true)).success).toBe(true);
  expect(await readdir(root)).not.toContain('partial');
  expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('dirty');
});

it('rejects stale operations before filesystem cleanup', async () => {
  const { root } = await fixture();
  get.mockResolvedValue({
    path: root,
    workspace_storage: { operationId: 'new', phase: 'cleanup' },
  });
  const result = await handleBranchStorage(
    {
      command: 'branch.storage',
      sessionToken: 'fixture',
      params: {
        branchId: 'branch',
        operationId: 'old',
        action: 'cleanup',
        cwd: root,
        principalBranchAccess: 'write',
      },
    } as BranchStoragePayload,
    {}
  );
  expect(result.success).toBe(false);
  expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('dirty');
  expect(fetch).not.toHaveBeenCalled();
});

it('fails an early HTTP rejection without hanging the pack stream or removing source files', async () => {
  const { root, run } = await fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 403 }))
  );
  expect((await run('pack')).success).toBe(false);
  expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('dirty');
});
