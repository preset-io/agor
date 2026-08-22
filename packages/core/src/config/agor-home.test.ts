import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGOR_HOME_MODE, ensureAgorHome, ensureAgorHomeSync } from './agor-home.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('Agor home creation policy', () => {
  let root: string;
  let homePath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agor-home-test-'));
    homePath = path.join(root, '.agor');
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it.each([0o000, 0o022, 0o077])('creates a fresh home as 0700 under umask %o', async (umask) => {
    const previousUmask = process.umask(umask);
    try {
      await ensureAgorHome(homePath);
    } finally {
      process.umask(previousUmask);
    }

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(AGOR_HOME_MODE);
  });

  it('leaves an existing operator-managed mode unchanged by default', async () => {
    await fsp.mkdir(homePath, { mode: 0o750 });

    await ensureAgorHome(homePath);

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(0o750);
  });

  it('repairs an existing fresh-install target when explicitly requested', async () => {
    await fsp.mkdir(homePath, { mode: 0o755 });

    await ensureAgorHome(homePath, { enforceExistingMode: true });

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(AGOR_HOME_MODE);
  });

  it('refuses to chmod through a symlink when enforcing setup policy', async () => {
    const target = path.join(root, 'operator-directory');
    await fsp.mkdir(target, { mode: 0o755 });
    await fsp.symlink(target, homePath, 'dir');

    await expect(ensureAgorHome(homePath, { enforceExistingMode: true })).rejects.toThrow(
      /not a directory/
    );
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o755);
  });

  it('applies the same policy at synchronous CLI file-creation boundaries', () => {
    ensureAgorHomeSync(homePath);

    expect(fs.statSync(homePath).mode & 0o777).toBe(AGOR_HOME_MODE);
  });
});
