import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  bundleParts: z.number().int().min(0).max(1024).default(0),
  tags: z
    .array(z.tuple([z.string().startsWith('refs/tags/'), z.string().regex(/^[a-f0-9]{40,64}$/)]))
    .default([]),
});

// The source protocol bounds individual blobs to 128 MiB. Large repositories
// therefore store a Git bundle as independently verified 64-MiB parts.
export async function splitGitBundle(
  directory: string,
  partBytes = 64 * 1024 ** 2
): Promise<number> {
  const bundle = path.join(directory, 'history.bundle');
  const file = await open(bundle, 'r');
  let count = 0;
  try {
    const buffer = Buffer.allocUnsafe(partBytes);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await writeFile(
        path.join(directory, `history.part-${count++}`),
        buffer.subarray(0, bytesRead),
        { mode: 0o600 }
      );
    }
  } finally {
    await file.close();
  }
  await rm(bundle);
  return count;
}

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
  if (head) {
    await git.raw([
      'bundle',
      'create',
      path.join(destination, 'history.bundle'),
      'HEAD',
      ...seed.tags.map(([ref]) => ref),
    ]);
    seed.bundleParts = await splitGitBundle(destination);
  }
  await writeFile(path.join(destination, 'seed.json'), JSON.stringify(seed), { mode: 0o600 });
}

const templates = new Map<string, Promise<void>>();
async function prepareGitTemplate(
  seedDirectory: string,
  template: string,
  seed: z.infer<typeof Seed>
): Promise<void> {
  try {
    const stat = await lstat(template);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Git template');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = path.join(path.dirname(template), `git-init-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const { git } = createGit(staging);
    await git.init();
    await git.raw(['check-ref-format', seed.branch]);
    await git.raw(['symbolic-ref', 'HEAD', seed.branch]);
    if (seed.head) {
      let bundle = path.join(seedDirectory, 'history.bundle');
      if (seed.bundleParts) {
        bundle = path.join(staging, 'history.bundle');
        await writeFile(bundle, '', { mode: 0o600 });
        for (let i = 0; i < seed.bundleParts; i++)
          await appendFile(bundle, await readFile(path.join(seedDirectory, `history.part-${i}`)));
      }
      await git.raw(['bundle', 'unbundle', bundle]);
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
    try {
      await rename(path.join(staging, '.git'), template);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      if (!(await lstat(template)).isDirectory()) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
/** Clone private Git state from a trusted immutable template; never share mutable inodes. */
export async function installGitSeed(
  seedDirectory: string,
  workspace: string,
  clone: 'copy' | 'reflink' = 'copy'
): Promise<void> {
  try {
    const stat = await lstat(path.join(workspace, '.git'));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Replica Git metadata must be a private directory');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const raw = await readFile(path.join(seedDirectory, 'seed.json'), 'utf8');
  const seed = Seed.parse(JSON.parse(raw));
  const key = createHash('sha256').update(raw).digest('hex');
  // This lives OUTSIDE the synchronized seed workspace and is never given to a tool.
  const template = path.join(path.dirname(seedDirectory), `git-template-${key}`);
  let pending = templates.get(template);
  if (!pending) {
    pending = prepareGitTemplate(seedDirectory, template, seed);
    templates.set(template, pending);
  }
  try {
    await pending;
  } finally {
    if (templates.get(template) === pending) templates.delete(template);
  }
  const staging = path.join(path.dirname(workspace), `git-copy-${randomUUID()}`);
  try {
    await cp(template, staging, {
      recursive: true,
      mode: clone === 'reflink' ? constants.COPYFILE_FICLONE_FORCE : 0,
    });
    await rename(staging, path.join(workspace, '.git'));
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
