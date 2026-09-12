import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createGit } from '@agor/git';
import type { Entry, Mutation, Tree, WorkspaceBlobs } from './types';
import { WorkspaceError } from './types';

export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.pnpm-store',
  'target',
  'dist',
  'build',
  'coverage',
  '.tmp',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
  '.m2',
  '.agor-substrate',
];
const SECRET_NAMES = new Set([
  'auth.json',
  '.credentials.json',
  '.pypirc',
  '.netrc',
  '.ssh',
  '.aws',
  '.kube',
  '.codex',
]);
/** Repository configuration may share names with private home configuration. */
export function isRepositoryConfiguration(value: string): boolean {
  return value
    .split('/')
    .some((p) => p === '.npmrc' || p === '.claude' || p === '.env' || p.startsWith('.env.'));
}
export function repositoryPaths(tree: Tree): Set<string> {
  return new Set(
    Object.entries(tree)
      .filter(([, e]) => e.repositoryConfig === true)
      .map(([name]) => name)
  );
}
async function trackedConfiguration(root: string, known: Set<string>): Promise<Set<string>> {
  const admitted = new Set(known);
  // Do not accidentally discover a parent repository for a Git-less replica.
  try {
    await lstat(path.join(root, '.git'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return admitted;
    throw error;
  }
  const { git } = createGit(root);
  for (const name of (await git.raw(['ls-files', '-z', '--cached'])).split('\0').filter(Boolean)) {
    if (!isRepositoryConfiguration(name)) continue;
    validPath(name);
    admitted.add(name);
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      admitted.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return admitted;
}
export function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
export function validPath(value: string): void {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    value
      .split('/')
      .some(
        (p) =>
          !p || p === '.' || p === '..' || ['__proto__', 'constructor', 'prototype'].includes(p)
      )
  )
    throw new WorkspaceError('INVALID', 'Invalid workspace-relative path');
}
export function included(value: string, excludes: string[], admitted = new Set<string>()): boolean {
  validPath(value);
  return !value
    .split('/')
    .some(
      (p) =>
        SECRET_NAMES.has(p) ||
        (isRepositoryConfiguration(p) && !admitted.has(value)) ||
        DEFAULT_EXCLUDES.includes(p) ||
        excludes.includes(p)
    );
}
export function equal(a?: Entry, b?: Entry): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.target === b.target &&
    a.repositoryConfig === b.repositoryConfig
  );
}
export function validateTree(tree: Tree, excludes: string[]): void {
  const admitted = repositoryPaths(tree);
  for (const [name, entry] of Object.entries(tree)) {
    if (!included(name, excludes, admitted))
      throw new WorkspaceError('INVALID', `Excluded path: ${name}`);
    if (
      !['file', 'directory', 'symlink'].includes(entry.kind) ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new WorkspaceError('CORRUPT', 'Invalid tree entry');
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (tree[parent]?.kind !== 'directory')
        throw new WorkspaceError('INVALID', `Non-directory ancestor: ${parent}`);
      parent = path.posix.dirname(parent);
    }
    if (entry.kind === 'symlink') {
      const target = entry.target;
      if (
        !target ||
        target.includes('\0') ||
        target.includes('\\') ||
        path.posix.isAbsolute(target)
      )
        throw new WorkspaceError('INVALID', 'Absolute or invalid symlink');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (
        resolved === '..' ||
        resolved.startsWith('../') ||
        (resolved !== '.' && !included(resolved, excludes, admitted))
      )
        throw new WorkspaceError('INVALID', `Symlink escapes synchronized content: ${name}`);
      if (entry.hash !== hash(target))
        throw new WorkspaceError('CORRUPT', 'Symlink checksum mismatch');
    }
  }
}

/** Walk without following links; generated subtrees are pruned before any file reads. */
export async function scan(
  root: string,
  excludes: string[],
  limits: { maximumBytes: number; maximumFiles: number },
  onFile?: (name: string, entry: Entry, bytes: Buffer) => Promise<void>,
  signal?: AbortSignal,
  knownRepositoryPaths = new Set<string>()
): Promise<{ tree: Tree; excluded: number }> {
  const tree: Tree = Object.create(null);
  const admitted = await trackedConfiguration(root, knownRepositoryPaths);
  let total = 0;
  let count = 0;
  let excluded = 0;
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  const check = () => {
    signal?.throwIfAborted();
    if (failure) throw failure;
  };
  const visit = async (dir: string) => {
    for (const name of (await readdir(path.join(root, dir))).sort()) {
      check();
      const relative = dir ? `${dir}/${name}` : name;
      if (!included(relative, excludes, admitted)) {
        excluded++;
        continue;
      }
      if (++count > limits.maximumFiles)
        throw new WorkspaceError('CAPACITY', 'Workspace file limit exceeded');
      const absolute = path.join(root, relative);
      const st = await lstat(absolute);
      const mode = st.mode & 0o777;
      if (st.isDirectory()) {
        tree[relative] = { kind: 'directory', hash: hash('directory'), mode, size: 0 };
        await visit(relative);
      } else if (st.isSymbolicLink()) {
        const target = await readlink(absolute);
        tree[relative] = {
          kind: 'symlink',
          hash: hash(target),
          mode: 0o777,
          size: Buffer.byteLength(target),
          target,
        };
      } else if (st.isFile()) {
        if (st.size > 128 * 1024 * 1024)
          throw new WorkspaceError('CAPACITY', 'Single file exceeds 128 MiB blob limit');
        total += st.size;
        if (total > limits.maximumBytes)
          throw new WorkspaceError('CAPACITY', 'Workspace byte limit exceeded');
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const actual = await file.stat();
          if (actual.ino !== st.ino || actual.size !== st.size)
            throw new WorkspaceError('BUSY', 'Workspace changed during extraction');
          const bytes = await file.readFile();
          const after = await file.stat();
          if (after.mtimeMs !== actual.mtimeMs || after.size !== actual.size)
            throw new WorkspaceError('BUSY', 'Workspace changed during extraction');
          const entry: Entry = { kind: 'file', hash: hash(bytes), mode, size: bytes.length };
          tree[relative] = entry;
          if (onFile) {
            const operation = onFile(relative, entry, bytes).catch((error) => {
              failure ??= error;
            });
            pending.add(operation);
            void operation.then(() => pending.delete(operation));
            if (pending.size >= 8) await Promise.race(pending);
            check();
          }
        } finally {
          await file.close();
        }
      } else throw new WorkspaceError('INVALID', `Unsupported special file: ${relative}`);
    }
  };
  if (!(await lstat(root)).isDirectory())
    throw new WorkspaceError('INVALID', 'Workspace root must be a directory');
  try {
    await visit('');
  } finally {
    await Promise.all(pending);
  }
  check();
  for (const [name, entry] of Object.entries(tree))
    if (admitted.has(name)) entry.repositoryConfig = true;
  validateTree(tree, excludes);
  return { tree, excluded };
}
export function mutations(before: Tree, after: Tree): Mutation[] {
  const changes: Mutation[] = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[name];
    const b = after[name];
    if (!equal(a, b))
      changes.push({
        path: name,
        operation: !a
          ? 'create'
          : !b
            ? 'delete'
            : a.hash === b.hash && a.kind === b.kind
              ? 'mode'
              : 'replace',
        ...(a ? { before: a } : {}),
        ...(b ? { after: b } : {}),
      });
  }
  // Rename is represented by a paired delete/create, preserving both OCC checks.
  const removed = changes.filter((c) => c.operation === 'delete' && c.before?.kind !== 'directory');
  for (const added of changes.filter(
    (c) => c.operation === 'create' && c.after?.kind !== 'directory'
  )) {
    const candidates = removed.filter((c) => equal(c.before, added.after));
    if (candidates.length === 1) {
      added.operation = 'rename';
      added.from = candidates[0].path;
      removed.splice(removed.indexOf(candidates[0]), 1);
    }
  }
  return changes;
}
/** Destination is a fresh private directory. Never extract through executor-owned paths. */
export async function render(
  root: string,
  tree: Tree,
  blobs: WorkspaceBlobs,
  excludes: string[],
  source?: string,
  clone: 'copy' | 'reflink' = 'copy',
  signal?: AbortSignal
): Promise<void> {
  validateTree(tree, excludes);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const directories = Object.entries(tree)
    .filter(([, e]) => e.kind === 'directory')
    .sort(([a], [b]) => a.length - b.length);
  for (const [name] of directories) await mkdir(path.join(root, name), { mode: 0o700 });
  const files = Object.entries(tree);
  for (let start = 0; start < files.length; start += 8) {
    signal?.throwIfAborted();
    const results = await Promise.allSettled(
      files.slice(start, start + 8).map(async ([name, entry]) => {
        const dest = path.join(root, name);
        if (entry.kind === 'file') {
          if (source)
            await copyFile(
              path.join(source, name),
              dest,
              clone === 'reflink' ? constants.COPYFILE_FICLONE_FORCE : 0
            );
          else {
            const bytes = await blobs.get(entry.hash);
            if (hash(bytes) !== entry.hash || bytes.length !== entry.size)
              throw new WorkspaceError('CORRUPT', `Blob checksum mismatch: ${name}`);
            await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
          }
          await chmod(dest, entry.mode);
        } else if (entry.kind === 'symlink') await symlink(entry.target!, dest);
      })
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  signal?.throwIfAborted();
  for (const [name, entry] of directories.reverse()) await chmod(path.join(root, name), entry.mode);
}

/** Idle replicas can apply a revision in place: a durable dirty marker blocks tool admission until complete. */
export async function refresh(
  root: string,
  before: Tree,
  after: Tree,
  blobs: WorkspaceBlobs,
  excludes: string[]
): Promise<void> {
  validateTree(after, excludes);
  const changes = mutations(before, after);
  const fs = await import('node:fs/promises');
  if (!changes.length) return;
  const touchedDirs = new Set<string>();
  for (const c of changes) {
    if (c.before?.kind === 'directory' || c.after?.kind === 'directory') touchedDirs.add(c.path);
    let parent = path.posix.dirname(c.path);
    while (parent !== '.') {
      touchedDirs.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  // Only changed ancestors need mode adjustments; unchanged trees need no filesystem calls.
  for (const name of [...touchedDirs].sort((a, b) => a.length - b.length))
    if (before[name]?.kind === 'directory') await fs.chmod(path.join(root, name), 0o700);
  for (const c of [...changes].sort((a, b) => b.path.length - a.path.length)) {
    if (c.before && (!c.after || c.before.kind !== c.after.kind))
      await fs.rm(path.join(root, c.path), { recursive: true, force: true });
  }
  for (const c of [...changes].sort((a, b) => a.path.length - b.path.length)) {
    if (!c.after) continue;
    const destination = path.join(root, c.path);
    if (c.after.kind === 'directory') await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    else if (c.after.kind === 'symlink') {
      await fs.rm(destination, { force: true });
      await fs.symlink(c.after.target!, destination);
    } else {
      if (c.before?.hash !== c.after.hash || c.before.kind !== 'file') {
        const bytes = await blobs.get(c.after.hash);
        if (hash(bytes) !== c.after.hash || bytes.length !== c.after.size)
          throw new WorkspaceError('CORRUPT', 'Revision blob mismatch');
        // Directory is controller-owned while idle; no tools can observe intermediate files.
        await fs.rm(destination, { force: true });
        await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      }
      await fs.chmod(destination, c.after.mode);
    }
  }
  for (const name of [...touchedDirs].sort((a, b) => b.length - a.length))
    if (after[name]?.kind === 'directory') await fs.chmod(path.join(root, name), after[name].mode);
}

/** Move excluded descendants into a rebuilt replica without following user symlinks.
 * Included files are always restored from authority, never salvaged after a crash.
 */
export async function preserveLocalPaths(
  source: string,
  destination: string,
  excludes: string[],
  restoredTree: Tree = {}
): Promise<void> {
  const admitted = await trackedConfiguration(source, repositoryPaths(restoredTree));
  const fs = await import('node:fs/promises');
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(destination, name);
      if (!included(name, excludes, admitted)) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(path.join(source, name), target);
      } else if (entry.isDirectory()) {
        // A source deletion/type change wins over caches beneath that directory.
        const stat = await fs.lstat(target).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) await visit(name);
      }
    }
  }
  try {
    await visit('');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
