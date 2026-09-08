import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat as nodeStat, type PathLike, type Stats } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireAgenticToolInstallLock } from './agentic-tool-integrations.js';

// Intercept the dependency's stale observation, not its mkdir/rmdir/lock logic.
const require = createRequire(import.meta.url);
const lockFs = createRequire(require.resolve('proper-lockfile'))('graceful-fs') as {
  stat(path: PathLike, callback: (error: NodeJS.ErrnoException | null, stats: Stats) => void): void;
};
const originalRoot = process.env.AGOR_AGENTIC_TOOLS_DIR;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalRoot === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
  else process.env.AGOR_AGENTIC_TOOLS_DIR = originalRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('does not admit a second reclaimer while the first holds a stale observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-install-race-'));
  roots.push(root);
  process.env.AGOR_AGENTIC_TOOLS_DIR = root;
  const lock = join(root, '.install.lock');
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  let resume: (() => void) | undefined;
  let observed!: () => void;
  const staleObserved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  vi.spyOn(lockFs, 'stat').mockImplementation((path, callback) => {
    nodeStat(path, (error, stats) => {
      if (path === lock && !error && stats.mtimeMs === 0 && !resume) {
        resume = () => callback(error, stats);
        observed();
      } else callback(error, stats);
    });
  });
  const first = acquireAgenticToolInstallLock();
  let secondRelease: (() => Promise<void>) | undefined;
  try {
    await staleObserved;
    // Before the fix, this contender succeeds. Resuming the first then lets it
    // remove that fresh directory using its previously captured stale stat.
    await expect(
      acquireAgenticToolInstallLock().then((release) => {
        secondRelease = release;
        return release;
      })
    ).rejects.toThrow('Another `agor install`');
  } finally {
    resume?.();
    const result = await Promise.allSettled([first]);
    // The old implementation may return two releases for one replaced lock.
    // Always clean up both paths, including when this regression fails.
    await Promise.allSettled([
      ...(secondRelease ? [secondRelease()] : []),
      ...(result[0].status === 'fulfilled' ? [result[0].value()] : []),
    ]);
    expect(result[0].status, 'the paused installer recovers after resuming').toBe('fulfilled');
  }
});

it('fails closed on an abandoned acquisition guard rather than racing to reclaim it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-install-guard-'));
  roots.push(root);
  process.env.AGOR_AGENTIC_TOOLS_DIR = root;
  const guard = join(root, '.install.acquire.lock');
  await mkdir(guard, { mode: 0o700 });
  await utimes(guard, new Date(0), new Date(0));
  await expect(acquireAgenticToolInstallLock()).rejects.toThrow(
    'verify that no installer is running'
  );
  expect((await stat(guard)).mtimeMs).toBe(0);
  await expect(access(join(root, '.install.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('scopes acquisition and leases to the installation root', async () => {
  const releases: (() => Promise<void>)[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const root = await mkdtemp(join(tmpdir(), 'agor-install-root-'));
      roots.push(root);
      process.env.AGOR_AGENTIC_TOOLS_DIR = root;
      releases.push(await acquireAgenticToolInstallLock());
      await expect(access(join(root, '.install.acquire.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  } finally {
    await Promise.all(releases.map((release) => release()));
  }
});

it.each([false, true])(
  'admits one independent installer process (stale=%s)',
  async (stale) => {
    const root = await mkdtemp(join(tmpdir(), 'agor-install-process-'));
    roots.push(root);
    if (stale) {
      const lock = join(root, '.install.lock');
      await mkdir(lock);
      await utimes(lock, new Date(0), new Date(0));
    }
    const code = `
    import { acquireAgenticToolInstallLock } from ${JSON.stringify(new URL('./agentic-tool-integrations.ts', import.meta.url).href)};
    process.once('message', async () => {
      try {
        const release = await acquireAgenticToolInstallLock();
        process.once('message', async () => { await release(); process.disconnect(); });
        process.send({ status: 'held' });
      } catch (error) {
        process.send({ status: 'busy', message: error.message });
        process.disconnect();
      }
    });
    process.send('ready');
  `;
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        ['--import', 'tsx', '--conditions=source', '--input-type=module', '--eval', code],
        {
          env: { ...process.env, AGOR_AGENTIC_TOOLS_DIR: root },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }
      )
    );
    const exits = children.map((child) => once(child, 'exit'));
    try {
      const signal = AbortSignal.timeout(15000);
      await Promise.all(children.map((child) => once(child, 'message', { signal })));
      const results = children.map((child) => once(child, 'message', { signal }));
      children.forEach((child) => {
        child.send('acquire');
      });
      const outcomes = (await Promise.all(results)).map(
        ([result]) => result as { status: string; message?: string }
      );
      expect(outcomes.filter((result) => result.status === 'held')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'busy')).toEqual([
        { status: 'busy', message: expect.stringContaining('Another `agor install`') },
      ]);
      children[outcomes.findIndex((result) => result.status === 'held')].send('release');
      expect(await Promise.all(exits)).toEqual([
        [0, null],
        [0, null],
      ]);
    } finally {
      children.forEach((child) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      await Promise.allSettled(exits);
    }
  },
  20000
);
