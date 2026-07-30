import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOpenCodeDataHome,
  type ManagedChild,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from './managed-server';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenCode native data boundary', () => {
  it('provisions a private namespace and verifies OpenCode-owned auth permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-boundary-'));
    roots.push(root);
    const dataHome = join(root, 'namespace');

    await ensureOpenCodeDataHome(dataHome);
    const directory = await stat(dataHome);
    expect(directory.mode & 0o777).toBe(0o700);
    if (typeof process.getuid === 'function') expect(directory.uid).toBe(process.getuid());

    const authDir = join(dataHome, 'opencode');
    await ensureOpenCodeDataHome(authDir);
    const authPath = join(authDir, 'auth.json');
    await writeFile(authPath, '{"synthetic":true}', { mode: 0o600 });

    await expect(verifyOpenCodeAuthFileBoundary(dataHome)).resolves.toBeUndefined();
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, 'utf8')).toBe('{"synthetic":true}');
  });

  it('rejects a symlink instead of provisioning through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-symlink-'));
    roots.push(root);
    const target = join(root, 'target');
    const dataHome = join(root, 'namespace');
    await ensureOpenCodeDataHome(target);
    await symlink(target, dataHome);

    await expect(ensureOpenCodeDataHome(dataHome)).rejects.toThrow(/symbolic link/i);
  });
});

describe('managed OpenCode readiness', () => {
  it('waits for authenticated HTTP health after the listener announcement', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => true,
    }) as ManagedChild;
    const fetchHealth = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const started = startManagedOpenCodeServer(
      { directory: tmpdir() },
      {
        resolveBinary: async () => '/packaged/opencode',
        spawn: () => child,
        randomBytes: () => Buffer.alloc(32, 1),
        fetch: fetchHealth,
        readinessTimeoutMs: 500,
      }
    );
    child.stdout.write('opencode server listening on http://127.0.0.1:43210\n');

    const server = await started;

    expect(fetchHealth).toHaveBeenCalledTimes(2);
    expect(fetchHealth).toHaveBeenLastCalledWith(
      'http://127.0.0.1:43210/global/health',
      expect.objectContaining({
        headers: { Authorization: server.authorization },
      })
    );
  });
});
