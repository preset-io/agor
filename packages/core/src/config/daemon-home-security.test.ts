import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { secureOwnerDirectory, secureOwnerFileIfPresent } from './daemon-home-security';

describe('daemon home security', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a fresh private home and repairs existing permissive state', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agor-home-security-'));
    const home = path.join(tempDir, 'home');
    await secureOwnerDirectory(home);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);

    const secret = path.join(home, 'config.yaml');
    await writeFile(secret, 'secret', { mode: 0o644 });
    await chmod(home, 0o755);
    await secureOwnerDirectory(home);
    await secureOwnerFileIfPresent(secret);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect((await lstat(secret)).mode & 0o777).toBe(0o600);
  });

  it('refuses symlinked homes and secret files', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agor-home-security-'));
    const real = path.join(tempDir, 'real');
    await mkdir(real);
    const linkedHome = path.join(tempDir, 'home');
    await symlink(real, linkedHome);
    await expect(secureOwnerDirectory(linkedHome)).rejects.toThrow(/expected.*directory/i);

    const realFile = path.join(real, 'real-config');
    await writeFile(realFile, 'secret');
    const linkedFile = path.join(real, 'config.yaml');
    await symlink(realFile, linkedFile);
    await expect(secureOwnerFileIfPresent(linkedFile)).rejects.toThrow(/regular file/i);
  });
});
