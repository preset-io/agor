import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOpenCodeDataHome,
  type ManagedChild,
  refreshOpenCodeModels,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from './managed-server';

const roots: string[] = [];

function nativeDataHome(root: string, namespace = 'namespace'): string {
  return join(root, 'home', '.local', 'share', 'agor', 'opencode', namespace);
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenCode native data boundary', () => {
  it('provisions a private namespace and verifies OpenCode-owned auth permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-boundary-'));
    roots.push(root);
    const dataHome = nativeDataHome(root);

    await ensureOpenCodeDataHome(dataHome);
    const directory = await stat(dataHome);
    expect(directory.mode & 0o777).toBe(0o700);
    if (typeof process.getuid === 'function') expect(directory.uid).toBe(process.getuid());

    const authDir = join(dataHome, 'opencode');
    const authPath = join(authDir, 'auth.json');
    await writeFile(authPath, '{"synthetic":true}', { mode: 0o600 });

    await expect(verifyOpenCodeAuthFileBoundary(dataHome)).resolves.toBeUndefined();
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, 'utf8')).toBe('{"synthetic":true}');
  });

  it('tightens a safe legacy native directory without rewriting its auth file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-legacy-mode-'));
    roots.push(root);
    const dataHome = nativeDataHome(root);
    await ensureOpenCodeDataHome(dataHome);
    const authDir = join(dataHome, 'opencode');
    const authPath = join(authDir, 'auth.json');
    await writeFile(authPath, '{"legacy":true}', { mode: 0o600 });
    await chmod(authDir, 0o755);

    await ensureOpenCodeDataHome(dataHome);

    expect((await stat(authDir)).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, 'utf8')).toBe('{"legacy":true}');
  });

  it('does not repair a group-writable native directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-writable-mode-'));
    roots.push(root);
    const dataHome = nativeDataHome(root);
    await ensureOpenCodeDataHome(dataHome);
    const authDir = join(dataHome, 'opencode');
    await chmod(authDir, 0o770);

    await expect(ensureOpenCodeDataHome(dataHome)).rejects.toThrow(/group- or world-writable/i);
    expect((await stat(authDir)).mode & 0o777).toBe(0o770);
  });

  it('rejects a symlink instead of provisioning through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-symlink-'));
    roots.push(root);
    const home = join(root, 'home');
    const target = join(root, 'target');
    const dataHome = nativeDataHome(root);
    await mkdir(home, { mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(home, '.local'));

    await expect(ensureOpenCodeDataHome(dataHome)).rejects.toThrow(/symbolic link/i);
  });

  it('rejects an unsafe existing auth file before a managed server can spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-auth-mode-'));
    roots.push(root);
    const dataHome = nativeDataHome(root);
    await ensureOpenCodeDataHome(dataHome);
    const authPath = join(dataHome, 'opencode', 'auth.json');
    await writeFile(authPath, '{}', { mode: 0o600 });
    await chmod(authPath, 0o644);
    const spawn = vi.fn();

    await expect(
      startManagedOpenCodeServer(
        { directory: tmpdir(), dataHome },
        { resolveBinary: async () => '/packaged/opencode', spawn }
      )
    ).rejects.toThrow(/unsafe permissions/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('managed OpenCode readiness', () => {
  it('namespaces every OpenCode XDG root under the private native-data home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-xdg-'));
    roots.push(root);
    const dataHome = nativeDataHome(root);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => true,
    }) as ManagedChild;
    const spawn = vi.fn(() => child);

    const started = startManagedOpenCodeServer(
      { directory: tmpdir(), dataHome },
      {
        resolveBinary: async () => ({
          executable: process.execPath,
          argsPrefix: ['/managed/opencode-ai/bin/opencode'],
        }),
        spawn,
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      }
    );
    child.stdout.write('opencode server listening on http://127.0.0.1:43210\n');
    const server = await started;

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/managed/opencode-ai/bin/opencode', 'serve', '--hostname=127.0.0.1', '--port=0'],
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_DATA_HOME: dataHome,
          XDG_CONFIG_HOME: join(dataHome, 'xdg-config'),
          XDG_CACHE_HOME: join(dataHome, 'xdg-cache'),
          XDG_STATE_HOME: join(dataHome, 'xdg-state'),
        }),
      })
    );
    for (const directory of [
      dataHome,
      join(dataHome, 'xdg-config'),
      join(dataHome, 'xdg-cache'),
      join(dataHome, 'xdg-state'),
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await server.close();
  });

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

describe('managed OpenCode model refresh', () => {
  it('refuses to refresh without a private native-state namespace', async () => {
    const spawn = vi.fn();

    await expect(
      refreshOpenCodeModels(
        { directory: '/workspace', providerId: 'opencode-go', dataHome: ' ' },
        { resolveBinary: async () => '/packaged/opencode', spawn }
      )
    ).rejects.toThrow(/requires a private native data home/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the pinned refresh command in the same private XDG namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-refresh-xdg-'));
    roots.push(root);
    const dataHome = nativeDataHome(root, 'alice-tenant');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: vi.fn(() => true),
    }) as ManagedChild;
    const spawn = vi.fn(() => child);

    const refreshed = refreshOpenCodeModels(
      {
        directory: '/workspace',
        providerId: 'opencode-go',
        dataHome,
        environment: { OPENCODE_CONFIG_CONTENT: '{"synthetic":true}' },
      },
      {
        resolveBinary: async () => ({
          executable: process.execPath,
          argsPrefix: ['/managed/opencode-ai/bin/opencode'],
        }),
        spawn,
      }
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/managed/opencode-ai/bin/opencode', 'models', 'opencode-go', '--refresh'],
      expect.objectContaining({
        cwd: '/workspace',
        env: expect.objectContaining({
          XDG_DATA_HOME: dataHome,
          XDG_CONFIG_HOME: join(dataHome, 'xdg-config'),
          XDG_CACHE_HOME: join(dataHome, 'xdg-cache'),
          XDG_STATE_HOME: join(dataHome, 'xdg-state'),
          OPENCODE_CONFIG_CONTENT: '{"synthetic":true}',
        }),
      })
    );
    child.exitCode = 0;
    child.emit('close', 0, null);

    await expect(refreshed).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('terminates the refresh child when the task is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-refresh-abort-'));
    roots.push(root);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: vi.fn(function (this: ManagedChild, signal: NodeJS.Signals) {
        this.exitCode = 0;
        queueMicrotask(() => {
          (this as unknown as EventEmitter).emit('exit', 0, signal);
          (this as unknown as EventEmitter).emit('close', 0, signal);
        });
        return true;
      }),
    }) as ManagedChild;
    const spawn = vi.fn(() => child);
    const controller = new AbortController();

    const refreshed = refreshOpenCodeModels(
      {
        directory: '/workspace',
        providerId: 'opencode-go',
        dataHome: nativeDataHome(root),
        signal: controller.signal,
      },
      { resolveBinary: async () => '/packaged/opencode', spawn }
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();

    await expect(refreshed).rejects.toThrow(/refresh was aborted/i);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sanitizes bounded native diagnostics when refresh exits unsuccessfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-opencode-refresh-failure-'));
    roots.push(root);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: vi.fn(() => true),
    }) as ManagedChild;
    const spawn = vi.fn(() => child);
    const secret = 'refresh-native-secret';

    const refreshed = refreshOpenCodeModels(
      {
        directory: '/workspace',
        providerId: 'opencode-go',
        dataHome: nativeDataHome(root),
        secrets: [secret],
      },
      { resolveBinary: async () => '/packaged/opencode', spawn }
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr?.emit('data', `failed with ${secret}`);
    child.exitCode = 1;
    child.emit('close', 1, null);

    const failure = await refreshed.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain(secret);
  });
});
