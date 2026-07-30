/**
 * Unit coverage for the tenant filesystem primitives — path-traversal and
 * symlink safety, deterministic walking, staging + atomic publication, and safe
 * idempotent deletion. Uses real temp directories; no database required.
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeRelativePath,
  copyRegularFileNoFollow,
  copyTenantFilesystemInto,
  deleteTenantFilesystemTree,
  publishTenantFilesystemAtomically,
  resolveWithinRoot,
  stageTenantFilesystem,
  summarizeTenantFilesystem,
  UnsafeArchivePathError,
  walkTenantFilesystemTree,
} from './tenant-filesystem';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-fs-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('assertSafeRelativePath', () => {
  it('accepts safe relative paths', () => {
    expect(assertSafeRelativePath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(assertSafeRelativePath('repos/org/repo/file')).toBe('repos/org/repo/file');
  });

  it('rejects traversal, absolute, drive, empty, and NUL paths', () => {
    expect(() => assertSafeRelativePath('../escape')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('a/../../b')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('/abs')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('C:/win')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('a//b')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('a/\0/b')).toThrow(UnsafeArchivePathError);
    expect(() => assertSafeRelativePath('a/./b')).toThrow(UnsafeArchivePathError);
  });
});

describe('resolveWithinRoot', () => {
  it('resolves inside and rejects escapes', () => {
    const root = join(scratch, 'root');
    expect(resolveWithinRoot(root, 'x/y')).toBe(join(root, 'x', 'y'));
    expect(() => resolveWithinRoot(root, '../y')).toThrow(UnsafeArchivePathError);
  });
});

async function seedTree(root: string): Promise<void> {
  await mkdir(join(root, 'repos', 'org'), { recursive: true });
  await writeFile(join(root, 'repos', 'org', 'a.txt'), 'alpha');
  await writeFile(join(root, 'top.txt'), 'top');
  await mkdir(join(root, 'uploads'), { recursive: true });
  await writeFile(join(root, 'uploads', 'z.bin'), Buffer.from([1, 2, 3, 4]));
}

describe('walkTenantFilesystemTree', () => {
  it('returns a deterministic, sorted, contents-free listing with hashes', async () => {
    const root = join(scratch, 'tenant');
    await seedTree(root);
    const first = await walkTenantFilesystemTree(root);
    const second = await walkTenantFilesystemTree(root);
    expect(first.entries.map((e) => e.path)).toEqual(second.entries.map((e) => e.path));
    // Sorted order.
    const paths = first.entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
    const fileEntry = first.entries.find((e) => e.path === 'repos/org/a.txt');
    expect(fileEntry?.type).toBe('file');
    expect(fileEntry?.size).toBe(5);
    expect(fileEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns empty for an absent root', async () => {
    const walk = await walkTenantFilesystemTree(join(scratch, 'nope'));
    expect(walk.entries).toEqual([]);
  });

  it('refuses a symlinked tenant root instead of following it', async () => {
    const realDir = join(scratch, 'real');
    await seedTree(realDir);
    const linkRoot = join(scratch, 'linkroot');
    await symlink(realDir, linkRoot);
    await expect(walkTenantFilesystemTree(linkRoot)).rejects.toThrow(UnsafeArchivePathError);
  });

  it('records internal symlinks and skips ones that escape the root', async () => {
    const root = join(scratch, 'tenant');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'real.txt'), 'real');
    await symlink('real.txt', join(root, 'sub', 'inside.link'));
    await symlink('../../../../etc/passwd', join(root, 'sub', 'escape.link'));
    const walk = await walkTenantFilesystemTree(root);
    const linkPaths = walk.entries.filter((e) => e.type === 'symlink').map((e) => e.path);
    expect(linkPaths).toContain('sub/inside.link');
    expect(linkPaths).not.toContain('sub/escape.link');
    expect(walk.unsafeSymlinkCount).toBe(1);
  });
});

describe('summarizeTenantFilesystem', () => {
  it('summarises counts and bytes without listing names', async () => {
    const root = join(scratch, 'tenant');
    await seedTree(root);
    const inv = await summarizeTenantFilesystem(root);
    expect(inv.present).toBe(true);
    expect(inv.fileCount).toBe(3);
    expect(inv.totalBytes).toBe(5 + 3 + 4);
    expect(inv.directoryCount).toBeGreaterThanOrEqual(3);
  });

  it('reports absence for a missing root', async () => {
    const inv = await summarizeTenantFilesystem(join(scratch, 'missing'));
    expect(inv.present).toBe(false);
    expect(inv.fileCount).toBe(0);
  });
});

describe('copy → stage → publish round trip', () => {
  it('reproduces the tree at a fresh destination via atomic publish', async () => {
    const source = join(scratch, 'src');
    await seedTree(source);
    const bundleFiles = join(scratch, 'bundle', 'files');
    const walk = await copyTenantFilesystemInto(source, bundleFiles);

    const staging = join(scratch, '.staging');
    await stageTenantFilesystem(walk.entries, bundleFiles, staging);
    const destination = join(scratch, 'restored');
    await publishTenantFilesystemAtomically(staging, destination);

    expect(await readFile(join(destination, 'repos', 'org', 'a.txt'), 'utf8')).toBe('alpha');
    const restored = await walkTenantFilesystemTree(destination);
    expect(restored.entries.map((e) => e.path)).toEqual(walk.entries.map((e) => e.path));
    // Content hashes survive the round trip.
    for (const entry of restored.entries) {
      if (entry.type !== 'file') continue;
      const original = walk.entries.find((e) => e.path === entry.path);
      expect(entry.sha256).toBe(original?.sha256);
    }
  });

  it('refuses to publish over a non-empty destination', async () => {
    const staging = join(scratch, '.staging2');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'a.txt'), 'a');
    const destination = join(scratch, 'occupied');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'existing.txt'), 'x');
    await expect(publishTenantFilesystemAtomically(staging, destination)).rejects.toThrow(
      UnsafeArchivePathError
    );
  });

  it('rejects staging a symlink whose target escapes the destination', async () => {
    const staging = join(scratch, '.staging3');
    await expect(
      stageTenantFilesystem(
        [{ path: 'evil.link', type: 'symlink', size: 0, linkTarget: '../../etc', mode: 0o777 }],
        join(scratch, 'bundle', 'files'),
        staging
      )
    ).rejects.toThrow(UnsafeArchivePathError);
  });

  it('refuses to copy through a symlink swapped in at a file path (O_NOFOLLOW)', async () => {
    // Simulates the TOCTOU where a path the walk saw as a regular file is
    // replaced by a symlink before the copy reads it.
    const secret = join(scratch, 'secret.txt');
    await writeFile(secret, 'secret');
    const source = join(scratch, 'source-now-a-symlink');
    await symlink(secret, source);
    const destination = join(scratch, 'copied.txt');
    await expect(copyRegularFileNoFollow(source, destination)).rejects.toThrow(
      UnsafeArchivePathError
    );
  });
});

describe('deleteTenantFilesystemTree', () => {
  it('deletes a tenant root under the base and is idempotent', async () => {
    const base = join(scratch, 'tenants');
    const tenantRoot = join(base, 'tenant-a');
    await seedTree(tenantRoot);
    const first = await deleteTenantFilesystemTree(tenantRoot, base);
    expect(first.deleted).toBe(true);
    await expect(stat(tenantRoot)).rejects.toBeTruthy();
    const second = await deleteTenantFilesystemTree(tenantRoot, base);
    expect(second.deleted).toBe(false);
  });

  it('refuses to delete the base itself', async () => {
    const base = join(scratch, 'tenants');
    await mkdir(base, { recursive: true });
    await expect(deleteTenantFilesystemTree(base, base)).rejects.toThrow(UnsafeArchivePathError);
  });

  it('refuses to delete a symlinked tenant root and leaves the target intact', async () => {
    const realTree = join(scratch, 'real-tree');
    await seedTree(realTree);
    const base = join(scratch, 'tenants');
    await mkdir(base, { recursive: true });
    // A symlink inside the base pointing at an unrelated tree must not be
    // followed (realpath would otherwise escape to the target).
    const linkTenant = join(base, 'tenant-link');
    await symlink(realTree, linkTenant);
    await expect(deleteTenantFilesystemTree(linkTenant, base)).rejects.toThrow(
      UnsafeArchivePathError
    );
    // The link's target tree is untouched.
    expect((await stat(join(realTree, 'top.txt'))).isFile()).toBe(true);
  });
});
