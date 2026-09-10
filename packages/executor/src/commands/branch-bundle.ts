import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BranchBundleDigest } from '@agor/core/types';
import { create, extract } from 'tar';
import { isPathInsideRoot } from './branch-filesystem.js';

/** Archive names are POSIX paths even when the consumer runs elsewhere. */
export function assertBundlePath(name: string): void {
  if (
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    posix.isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').includes('..')
  ) {
    throw new Error('Unsafe workspace archive path');
  }
}

function assertBundleLink(name: string, target: string, hardlink: boolean): void {
  if (
    !target ||
    target.includes('\\') ||
    target.includes('\0') ||
    posix.isAbsolute(target) ||
    /^[A-Za-z]:/.test(target)
  ) {
    throw new Error('Unsafe workspace archive link');
  }
  const resolved = posix.normalize(hardlink ? target : posix.join(posix.dirname(name), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error('Workspace archive link escapes workspace');
  }
}

function digestStream() {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, finish: (): BranchBundleDigest => ({ sha256: hash.digest('hex'), bytes }) };
}

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** No dissociation/repacking: unsupported Git dependencies are refused, not rewritten. */
export async function assertStandaloneClone(root: string): Promise<void> {
  const workspace = await lstat(root);
  const git = await lstat(join(root, '.git'));
  if (
    !workspace.isDirectory() ||
    workspace.isSymbolicLink() ||
    !git.isDirectory() ||
    git.isSymbolicLink()
  ) {
    throw new Error('Cold storage requires a self-contained clone');
  }
  await assertGitDirectory(join(root, '.git'));
}

async function assertGitDirectory(gitDirectory: string): Promise<void> {
  for (const dependency of ['objects/info/alternates', 'commondir']) {
    if ((await optionalText(join(gitDirectory, dependency))).trim()) {
      throw new Error('Clone has external Git dependencies');
    }
  }
  // Linked worktrees and config includes can depend on data outside the bundle.
  try {
    await lstat(join(gitDirectory, 'worktrees'));
    throw new Error('Clone has linked worktrees');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = await readFile(join(gitDirectory, 'config'), 'utf8');
  if (/^\s*\[include(?:If)?(?:\s|\])/im.test(config) || /^\s*worktree\s*=/im.test(config)) {
    throw new Error('Clone uses unsupported Git config indirection');
  }
}

/**
 * Single tar/gzip pass, including ignored files and .git. Hash the exact bytes
 * sent to storage. The caller must persist a verified receipt before cleanup.
 * This is best effort: callers must close Agor admission and stop external writers.
 */
export async function packBranchBundle(
  root: string,
  destination: Writable
): Promise<BranchBundleDigest> {
  await assertStandaloneClone(root);
  let rejected: Error | undefined;
  const nestedGitDirectories = new Set<string>();
  const archive = create(
    {
      cwd: root,
      gzip: true,
      strict: true,
      follow: false,
      filter: (_name, stat) => {
        if ('isFile' in stat && !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
          rejected = new Error('Workspace contains an unsupported special file');
          return false;
        }
        return true;
      },
      onWriteEntry: (entry) => {
        try {
          assertBundlePath(entry.path);
          if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
            assertBundleLink(entry.path, entry.linkpath ?? '', entry.type === 'Link');
          }
          if (
            entry.type === 'Directory' &&
            posix.basename(entry.path.replace(/\/$/, '')) === '.git'
          ) {
            nestedGitDirectories.add(entry.absolute);
          }
          // Submodule gitfiles must resolve within this clone, never into a base repo.
          if (entry.type === 'File' && posix.basename(entry.path) === '.git') {
            const text = readFileSync(entry.absolute, 'utf8');
            const target = text.match(/^gitdir: (.+)\s*$/)?.[1];
            if (
              !target ||
              !isPathInsideRoot(resolve(root), resolve(dirname(entry.absolute), target))
            ) {
              throw new Error('Workspace has an external Git directory');
            }
            nestedGitDirectories.add(resolve(dirname(entry.absolute), target));
          }
        } catch (error) {
          rejected = error as Error;
        }
      },
    },
    ['.']
  );
  const digest = digestStream();
  await pipeline(Readable.from(archive), digest.stream, destination);
  if (rejected) throw rejected;
  // Metadata only, not an archive/data verification pass. Includes embedded
  // repositories and submodule Git directories discovered during packing.
  for (const directory of nestedGitDirectories) await assertGitDirectory(directory);
  return digest.finish();
}

/**
 * Extract once into a NEW staging directory below a caller-owned private parent.
 * Restore temporarily needs room for both the compressed download and extracted
 * tree. The caller owns publication and failed-staging recovery; this function
 * never replaces the live workspace or deletes an existing staging directory.
 */
export async function restoreBranchBundle(
  body: Readable,
  staging: string,
  expected: BranchBundleDigest
): Promise<void> {
  await mkdir(staging, { mode: 0o700 });
  const download = await mkdtemp(join(dirname(staging), '.agor-bundle-download-'));
  const archivePath = join(download, 'workspace.tgz');
  let rejected: Error | undefined;
  try {
    const digest = digestStream();
    await pipeline(
      body,
      digest.stream,
      createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
    );
    const actual = digest.finish();
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error('Workspace bundle integrity verification failed');
    }
    // This runs in an executor, not the daemon event loop. Synchronous extraction
    // ensures an error cannot return while tar still has pending filesystem
    // writes into staging. Download once, extract once; no test extraction.
    extract({
      file: archivePath,
      sync: true,
      cwd: staging,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      chmod: true,
      processUmask: process.umask(),
      filter: (name, entry) => {
        try {
          assertBundlePath(name);
          if (
            !('type' in entry) ||
            !['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)
          ) {
            throw new Error('Unsupported workspace archive entry');
          }
          if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
            assertBundleLink(name, entry.linkpath ?? '', entry.type === 'Link');
          }
          return true;
        } catch (error) {
          rejected = error as Error;
          return false;
        }
      },
    });
    if (rejected) throw rejected;
    await assertStandaloneClone(staging);
  } finally {
    body.destroy();
    await rm(download, { recursive: true, force: true });
  }
}
