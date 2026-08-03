import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertCanonicalWorkspaceContainment } from './workspace-paths';

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
);

it('rejects a symlinked workspace ancestor that escapes the tenant root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agor-workspace-path-'));
  cleanup.push(base);
  const root = join(base, 'tenant-a', 'worktrees');
  const outside = join(base, 'tenant-b');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(root, 'org'));

  await expect(
    assertCanonicalWorkspaceContainment(root, join(root, 'org', 'repo', 'feature'))
  ).rejects.toThrow(/outside the managed root/);
});
