import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BranchDeletePayload } from '../payload-types';
import { handleBranchDelete } from './branch-deletion';

// Model a Cloud PVC's device IDs only. All path inspection and removal still
// operate on disposable real directories; no actual mounts or Jobs are created.
const devices = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (path: string) => {
      const info = await actual.stat(path);
      if (devices.has(path)) Object.defineProperty(info, 'dev', { value: devices.get(path) });
      return info;
    }),
    lstat: vi.fn(async (path: string) => {
      const info = await actual.lstat(path);
      if (devices.has(path)) Object.defineProperty(info, 'dev', { value: devices.get(path) });
      return info;
    }),
  };
});

afterEach(() => {
  devices.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'mounted',
  'absent_descendants',
  'image_local',
  'different_volume',
  'missing_home_mount',
  'foreign_root',
  'symlink_root',
  'symlink_home',
  'foreign_workspace',
  'traversal_workspace',
  'shared_home',
] as const)('delegated deletion verifies storage before removal: %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-delegated-delete-'));
  const tenant = join(root, 'tenant-a');
  const foreign = join(root, 'tenant-b');
  const id = '01900000-0000-7000-8000-000000000001';
  const worktrees = join(tenant, 'worktrees');
  const repos = join(tenant, 'repos');
  const homes = join(tenant, 'branch-homes');
  const workspace = join(worktrees, 'repo', 'victim');
  const home = join(homes, id);
  const retained = [
    join(worktrees, 'neighbor'),
    join(repos, 'base'),
    join(tenant, 'home', id),
    foreign,
  ];
  const actions: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const dir of [workspace, home, ...retained]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'keep'), 'fixture');
    }
    devices.set(tenant, 1);
    for (const dir of [worktrees, repos, homes]) devices.set(dir, 2);
    const params: BranchDeletePayload['params'] = {
      branchId: id,
      operationId: id,
      executionId: id,
      generation: 1,
      branchPath: workspace,
      branchesRoot: worktrees,
      repoPath: join(repos, 'base'),
      branchHome: home,
      tenantDataRoot: tenant,
      storageMode: 'clone',
      verifyDelegatedStorageMounts: true,
    };
    if (scenario === 'image_local')
      for (const dir of [worktrees, repos, homes]) devices.set(dir, 1);
    if (scenario === 'different_volume') devices.set(homes, 3);
    if (scenario === 'missing_home_mount') await rm(homes, { recursive: true });
    if (scenario === 'absent_descendants') {
      // A settled retry can find descendants already removed. The authoritative
      // mounted roots must still exist; a missing mount is never success.
      await rm(workspace, { recursive: true });
      await rm(home, { recursive: true });
    }
    if (scenario === 'foreign_root') {
      params.branchesRoot = foreign;
      params.branchPath = join(foreign, 'missing');
      devices.set(foreign, 2);
    }
    if (scenario === 'symlink_root') {
      await rm(worktrees, { recursive: true });
      await symlink(foreign, worktrees);
    }
    if (scenario === 'symlink_home') {
      await rm(home, { recursive: true });
      await symlink(foreign, home);
    }
    if (scenario === 'foreign_workspace') params.branchPath = foreign;
    if (scenario === 'traversal_workspace') params.branchPath = `${worktrees}/../../tenant-b`;
    if (scenario === 'shared_home') params.branchHome = join(tenant, 'home', id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, request: RequestInit) => {
        const body = JSON.parse(String(request.body));
        expect(body.branch_id).toBe(id);
        expect(body.execution_id).toBe(id);
        actions.push(body.action);
        return Response.json({ ok: true, remaining: false });
      })
    );
    const invoke = () =>
      handleBranchDelete(
        {
          command: 'branch.delete',
          daemonUrl: 'https://daemon.invalid',
          sessionToken: 'fixture-token',
          params,
        },
        {}
      );
    const result = await invoke();
    if (scenario === 'mounted' || scenario === 'absent_descendants') {
      expect(result.success).toBe(true);
      expect(actions).toEqual(['claim', 'quiesce', 'upload', 'storage', 'data', 'finalize']);
      await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(result.success).toBe(false);
      expect(actions).toEqual(['claim', 'quiesce', 'settled']);
      if (scenario !== 'symlink_root')
        expect(await readFile(join(workspace, 'keep'), 'utf8')).toBe('fixture');
      expect(JSON.stringify(log.mock.calls)).not.toContain(root);
    }
    for (const dir of retained) {
      if (scenario === 'symlink_root' && dir === retained[0]) continue;
      expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('fixture');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
