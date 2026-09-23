import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTenantNativeStateFilesystemTree } from './tenant-native-state-filesystem-preflight';

describe('native-state deletion preflight', () => {
  it('checks only native paths without reading unrelated tenant file bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    try {
      await mkdir(join(root, 'other'), { recursive: true });
      await writeFile(join(root, 'other', 'unrelated.bin'), 'ordinary tenant data');
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(false);
      for (const homeName of ['home', 'homes']) {
        const native = join(root, homeName, 'owner', '.local', 'share', 'agor', 'opencode');
        await mkdir(native, { recursive: true });
        expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
        await rm(join(root, homeName), { recursive: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a symlinked native-state ancestor without following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    const outside = await mkdtemp(join(tmpdir(), 'agor-native-outside-'));
    try {
      await mkdir(join(root, 'homes', 'owner'), { recursive: true });
      await symlink(outside, join(root, 'homes', 'owner', '.local'));
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
      await symlink(root, join(outside, 'linked-root'));
      await expect(
        hasTenantNativeStateFilesystemTree(join(outside, 'linked-root'))
      ).rejects.toThrow('symlinked tenant filesystem root');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
