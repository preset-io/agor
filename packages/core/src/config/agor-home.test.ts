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

  it('secures or fails closed when the umask removes all requested access', async () => {
    const previousUmask = process.umask(0o777);
    try {
      if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
        await ensureAgorHome(homePath);
      } else {
        await expect(ensureAgorHome(homePath)).rejects.toMatchObject({ code: 'EACCES' });
      }
    } finally {
      process.umask(previousUmask);
    }

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(
      typeof process.geteuid === 'function' && process.geteuid() === 0 ? AGOR_HOME_MODE : 0o000
    );
  });

  it('leaves an existing operator-managed mode unchanged by default', async () => {
    await fsp.mkdir(homePath, { mode: 0o750 });
    await fsp.chmod(homePath, 0o750);

    await ensureAgorHome(homePath);

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(0o750);
  });

  it('does not infer ownership from an empty-looking existing directory', async () => {
    await fsp.mkdir(homePath, { mode: 0o755 });
    await fsp.chmod(homePath, 0o755);

    await ensureAgorHome(homePath);

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(0o755);
  });

  it('preserves setgid mode on an existing shared directory', async () => {
    await fsp.mkdir(homePath);
    await fsp.chmod(homePath, 0o2770);

    await ensureAgorHome(homePath);

    expect((await fsp.stat(homePath)).mode & 0o7777).toBe(0o2770);
  });

  it('accepts an existing read-only operator-managed directory without chmod', async () => {
    await fsp.mkdir(homePath);
    await fsp.chmod(homePath, 0o555);

    await ensureAgorHome(homePath);

    expect((await fsp.stat(homePath)).mode & 0o777).toBe(0o555);
  });

  it('preserves an existing operator-managed symlink and its target mode', async () => {
    const target = path.join(root, 'operator-directory');
    await fsp.mkdir(target, { mode: 0o755 });
    await fsp.chmod(target, 0o755);
    await fsp.symlink(target, homePath, 'dir');

    await ensureAgorHome(homePath);

    expect((await fsp.stat(target)).mode & 0o777).toBe(0o755);
  });

  it('applies the same policy at synchronous CLI file-creation boundaries', () => {
    ensureAgorHomeSync(homePath);

    expect(fs.statSync(homePath).mode & 0o777).toBe(AGOR_HOME_MODE);
  });

  it('preserves an existing operator-managed mode at synchronous boundaries', () => {
    fs.mkdirSync(homePath);
    fs.chmodSync(homePath, 0o750);

    ensureAgorHomeSync(homePath);

    expect(fs.statSync(homePath).mode & 0o777).toBe(0o750);
  });
});
