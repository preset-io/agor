import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGit } from '@agor/git';
import { assertSafeGitRemoteUrl, stripGitUrlCredentials } from '@agor/git/pure';
import { z } from 'zod';

const Seed = z.object({
  head: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  branch: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/),
  remote: z.string().optional(),
  tags: z
    .array(z.tuple([z.string().startsWith('refs/tags/'), z.string().regex(/^[a-f0-9]{40,64}$/)]))
    .default([]),
});

/** Export reachable history only, never source config, hooks, credentials or worktree pointers. */
export async function exportGitSeed(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const { git } = createGit(source);
  if (!(await git.checkIsRepo())) throw new Error('Authorized branch source has no Git repository');
  const branch = (await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  const head = (await git.revparse(['--verify', 'HEAD']).catch(() => '')).trim() || null;
  const remote = (await git.raw(['remote', 'get-url', 'origin']).catch(() => '')).trim();
  let safeRemote: string | undefined;
  if (remote) {
    // Only ordinary network remotes are useful after moving hosts. Local paths,
    // executable transports and credential-bearing query strings are not copied.
    const candidate = stripGitUrlCredentials(remote);
    if (/^https?:\/\//.test(candidate)) {
      const url = new URL(candidate);
      url.search = '';
      url.hash = '';
      safeRemote = assertSafeGitRemoteUrl(url.toString());
    } else if (/^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(candidate)) {
      safeRemote = assertSafeGitRemoteUrl(candidate);
    }
  }
  const tags = head
    ? (
        await git.raw([
          'for-each-ref',
          '--merged=HEAD',
          '--format=%(refname) %(objectname)',
          'refs/tags',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
    : [];
  const seed = Seed.parse({
    head,
    branch: branch || 'refs/heads/workspace',
    remote: safeRemote,
    tags,
  });
  if (head)
    await git.raw([
      'bundle',
      'create',
      path.join(destination, 'history.bundle'),
      'HEAD',
      ...seed.tags.map(([ref]) => ref),
    ]);
  await writeFile(path.join(destination, 'seed.json'), JSON.stringify(seed), { mode: 0o600 });
}

/** Populate a fresh private Git directory without checking out over authoritative source files. */
export async function installGitSeed(seedDirectory: string, workspace: string): Promise<void> {
  try {
    const stat = await lstat(path.join(workspace, '.git'));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Replica Git metadata must be a private directory');
    return; // Preserve this replica's index, refs, commits and configuration.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const seed = Seed.parse(
    JSON.parse(await readFile(path.join(seedDirectory, 'seed.json'), 'utf8'))
  );
  const staging = path.join(path.dirname(workspace), `git-init-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const { git } = createGit(staging);
    await git.init();
    await git.raw(['check-ref-format', seed.branch]);
    await git.raw(['symbolic-ref', 'HEAD', seed.branch]);
    if (seed.head) {
      await git.raw(['bundle', 'unbundle', path.join(seedDirectory, 'history.bundle')]);
      await git.raw(['update-ref', seed.branch, seed.head]);
      await git.raw(['read-tree', seed.head]);
      for (const [ref, object] of seed.tags) {
        await git.raw(['check-ref-format', ref]);
        await git.raw(['update-ref', ref, object]);
      }
    }
    if (seed.remote) await git.addRemote('origin', assertSafeGitRemoteUrl(seed.remote));
    await git.addConfig('user.name', 'Agor');
    await git.addConfig('user.email', 'agor@localhost');
    await rename(path.join(staging, '.git'), path.join(workspace, '.git'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Paths are replica-private and never enter a source manifest or checkpoint. */
export const LOCAL_HOME_DIRECTORIES = ['.cache', '.npm', '.local', '.nvm'] as const;
export const LOCAL_TOOL_ENV = [
  'NVM_DIR=/home/agor/.nvm',
  'npm_config_cache=/home/agor/.npm',
  'npm_config_prefix=/home/agor/.local',
  'PIP_CACHE_DIR=/home/agor/.cache/pip',
  'PYTHONUSERBASE=/home/agor/.local',
  'PATH=/home/agor/.local/bin:/usr/local/bin:/usr/bin:/bin',
];
