import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDatabaseDirectory } from './database';

describe('SQLite filesystem security', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a fresh database home privately before connecting', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agor-db-security-'));
    const databaseDir = path.join(tempDir, 'private');
    await ensureDatabaseDirectory(`file:${path.join(databaseDir, 'agor.db')}`);
    expect((await lstat(databaseDir)).mode & 0o777).toBe(0o700);
  });

  it('repairs existing database and sidecar modes without seizing a custom parent', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agor-db-security-'));
    await chmod(tempDir, 0o755);
    const databasePath = path.join(tempDir, 'agor.db');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await writeFile(`${databasePath}${suffix}`, 'data', { mode: 0o644 });
    }

    await ensureDatabaseDirectory(`file:${databasePath}`);

    expect((await lstat(tempDir)).mode & 0o777).toBe(0o755);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect((await lstat(`${databasePath}${suffix}`)).mode & 0o777).toBe(0o600);
    }
  });
});
