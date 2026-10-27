import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { __resetConfigCacheForTests, getBranchesDir, getBranchPath } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertManagedBranchPath,
  managedBranchesRoot,
  removalBranchesRoot,
} from './managed-branch-path.js';

describe('assertManagedBranchPath', () => {
  let home: string;
  let originalHome: string | undefined;

  async function writeConfig(yaml: string) {
    await mkdir(join(home, '.agor'), { recursive: true });
    await writeFile(join(home, '.agor', 'config.yaml'), yaml);
    __resetConfigCacheForTests();
  }

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'agor-managed-branch-path-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    await writeConfig('multi_tenancy:\n  filesystem_isolation_enabled: true\n');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    __resetConfigCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  it('accepts the derived path for the same tenant, existing or not', async () => {
    const branchPath = getBranchPath('org/repo', 'feature', 'acme');
    expect(assertManagedBranchPath(branchPath, 'acme')).toBe(branchPath);
    await mkdir(branchPath, { recursive: true });
    expect(assertManagedBranchPath(branchPath, 'acme')).toBe(branchPath);
  });

  it.each([
    ['another tenant', () => getBranchPath('org/repo', 'victim', 'globex')],
    ['the filesystem root', () => '/'],
    ['the tenant branches root', () => getBranchesDir('acme')],
    ['an org directory', () => join(getBranchesDir('acme'), 'org')],
    ['a repository directory', () => join(getBranchesDir('acme'), 'org', 'repo')],
    ['a relative path', () => 'org/repo/feature'],
    ['a traversal', () => `${getBranchesDir('acme')}/org/../../globex/worktrees/org/repo`],
    ['a non-string', () => 42],
  ])('rejects %s', (_label, value) => {
    expect(() => assertManagedBranchPath(value(), 'acme')).toThrow(/outside this tenant/);
  });

  it('fails closed without a tenant when filesystem isolation is enabled', () => {
    expect(() => assertManagedBranchPath(getBranchPath('org/repo', 'feature', 'acme'))).toThrow();
  });

  it('rejects a path under a symlink planted in another branch workspace', async () => {
    const parent = getBranchPath('org/repo', 'parent', 'acme');
    const victim = getBranchPath('org/repo', 'victim', 'globex');
    await mkdir(parent, { recursive: true });
    await mkdir(victim, { recursive: true });
    await symlink(victim, join(parent, 'link'));
    expect(() => assertManagedBranchPath(join(parent, 'link', 'new'), 'acme')).toThrow(
      /traverses a symlink/
    );
  });

  it('rejects a symlink to a neighboring branch inside the same tenant', async () => {
    const neighbor = getBranchPath('org/repo', 'neighbor', 'acme');
    await mkdir(neighbor, { recursive: true });
    const alias = getBranchPath('org/repo', 'alias', 'acme');
    await symlink(neighbor, alias);
    expect(() => assertManagedBranchPath(alias, 'acme')).toThrow(/traverses a symlink/);
  });

  describe('migrated root alias', () => {
    // Documented migration: move worktrees to a new data home and keep the old
    // location as a symlink. Historical rows still name the old location.
    let dataHome: string;
    let legacyRoot: string;

    beforeEach(async () => {
      dataHome = join(home, 'data');
      await writeConfig(`paths:\n  data_home: ${dataHome}\n`);
      await mkdir(getBranchPath('org/repo', 'feature'), { recursive: true });
      legacyRoot = join(home, '.agor', 'worktrees');
      await symlink(join(dataHome, 'worktrees'), legacyRoot);
    });

    it('accepts historical paths and walks them from the alias root', () => {
      const historical = join(legacyRoot, 'org', 'repo', 'feature');
      expect(assertManagedBranchPath(historical)).toBe(historical);
      expect(managedBranchesRoot(historical)).toBe(legacyRoot);
      expect(managedBranchesRoot(getBranchPath('org/repo', 'feature'))).toBe(getBranchesDir());
    });

    it('hands removal walks the alias root, and the current root for invalid rows', () => {
      expect(removalBranchesRoot(join(legacyRoot, 'org', 'repo', 'feature'))).toBe(legacyRoot);
      expect(removalBranchesRoot(join(home, 'elsewhere', 'org', 'repo', 'x'))).toBe(
        getBranchesDir()
      );
    });

    it('rejects any other symlink to the root', async () => {
      const planted = join(home, 'planted');
      await symlink(join(dataHome, 'worktrees'), planted);
      expect(() => assertManagedBranchPath(join(planted, 'org', 'repo', 'feature'))).toThrow(
        /outside this tenant/
      );
    });

    it('rejects a symlink below the alias', async () => {
      const neighbor = getBranchPath('org/repo', 'neighbor');
      await mkdir(neighbor, { recursive: true });
      await symlink(neighbor, getBranchPath('org/repo', 'alias'));
      expect(() => assertManagedBranchPath(join(legacyRoot, 'org', 'repo', 'alias'))).toThrow(
        /traverses a symlink/
      );
    });

    it('rejects a repository directory through the alias', () => {
      expect(() => assertManagedBranchPath(join(legacyRoot, 'org', 'repo'))).toThrow(
        /outside this tenant/
      );
    });
  });
});
