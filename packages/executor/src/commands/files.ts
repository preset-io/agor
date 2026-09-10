import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type {
  FileDetail,
  FileListItem,
  GitFileStatus,
  GitFileStatusSource,
} from '@agor/core/types';
import { createGit } from '../git/index.js';
import type {
  BranchFilesBrowsePayload,
  BranchFilesReadPayload,
  BranchFilesystemStatusPayload,
  ExecutorResult,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import {
  filesystemStatus,
  resolveExecutorBranch,
  resolvePathInsideBranch,
} from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

const MAX_FILES = 50000;
const MAX_PREVIEW_SIZE = 1024 * 1024;
const MAX_TITLE_READ_BYTES = 4096;
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

function isTextFile(filePath: string, size: number): boolean {
  if (size > MAX_PREVIEW_SIZE) return false;
  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split('/').pop() || '';
  if (
    [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'composer.lock',
      'gemfile.lock',
      'cargo.lock',
      'poetry.lock',
    ].includes(fileName)
  ) {
    return false;
  }
  return [
    '.txt',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.css',
    '.scss',
    '.less',
    '.html',
    '.xml',
    '.svg',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.env',
    '.gitignore',
    '.dockerignore',
    '.sql',
    '.graphql',
    '.proto',
    '.toml',
    '.ini',
    '.vue',
    '.svelte',
    '.astro',
    '.makefile',
    '.dockerfile',
  ].some((extension) => lowerPath.endsWith(extension));
}

function getMimeType(filePath: string): string | undefined {
  return {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
  }[extname(filePath).toLowerCase()];
}

function extractTitle(content: string, filePath: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return (filePath.split('/').pop() || filePath).replace(/\.md$/, '');
}

async function scanDirectory(
  root: string,
  directory: string,
  files: FileListItem[]
): Promise<void> {
  if (files.length >= MAX_FILES) return;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return;
      const fullPath = join(directory, entry.name);
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink()) continue;
      const filePath = relative(root, fullPath).split(sep).join('/');
      if (filePath.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part))) continue;
      if (stats.isDirectory()) {
        await scanDirectory(root, fullPath, files);
      } else if (stats.isFile()) {
        let title = entry.name;
        if (filePath.endsWith('.md') && stats.size > 0 && stats.size <= MAX_PREVIEW_SIZE) {
          try {
            const handle = await open(fullPath, 'r');
            try {
              const buffer = Buffer.alloc(Math.min(MAX_TITLE_READ_BYTES, stats.size));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              title = extractTitle(buffer.subarray(0, bytesRead).toString('utf-8'), filePath);
            } finally {
              await handle.close();
            }
          } catch {
            title = entry.name;
          }
        }
        files.push({
          path: filePath,
          title,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
          isText: isTextFile(filePath, stats.size),
          mimeType: getMimeType(filePath),
        });
      }
    }
  } catch (error) {
    console.error(`[branch.files.browse] Failed to read directory ${directory}:`, error);
  }
}

/**
 * Classify a git porcelain XY status pair into a single VSCode-style status.
 * `x` is the index (staged) column, `y` is the working-tree column.
 * Returns null for an unrecognized/clean pair.
 */
function classifyPorcelain(x: string, y: string): GitFileStatus | null {
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!' && y === '!') return 'ignored';
  // Unmerged / conflict states: any 'U', plus the AA/DD both-sides pairs.
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflicted';
  }
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'modified';
  if (x === 'D' || y === 'D') return 'deleted';
  return null;
}

interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  originalPath?: string;
}

interface ResolvedPorcelainEntry {
  gitStatus: GitFileStatus;
  gitWorkingTreeStatus?: GitFileStatus;
  gitStagedStatus?: GitFileStatus;
  originalPath?: string;
}

function isConflictEntry(entry: PorcelainEntry): boolean {
  const { x, y } = entry;
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

function classifyStatusColumn(status: string): GitFileStatus | undefined {
  if (status === 'A') return 'added';
  if (status === 'M' || status === 'T') return 'modified';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  if (status === 'C') return 'copied';
  return undefined;
}

function resolveStatusDimensions(entries: PorcelainEntry[]): {
  gitWorkingTreeStatus?: GitFileStatus;
  gitStagedStatus?: GitFileStatus;
} {
  if (entries.some(isConflictEntry)) {
    // An unresolved index is presented as a working change rather than as a
    // safely staged change.
    return { gitWorkingTreeStatus: 'conflicted' };
  }

  let gitWorkingTreeStatus: GitFileStatus | undefined;
  let gitStagedStatus: GitFileStatus | undefined;
  for (const entry of entries) {
    if (entry.x === '?' && entry.y === '?') {
      gitWorkingTreeStatus = 'untracked';
      continue;
    }
    if (entry.x === '!' && entry.y === '!') {
      gitWorkingTreeStatus = 'ignored';
      continue;
    }
    gitStagedStatus = classifyStatusColumn(entry.x) ?? gitStagedStatus;
    gitWorkingTreeStatus = classifyStatusColumn(entry.y) ?? gitWorkingTreeStatus;
  }
  return {
    ...(gitWorkingTreeStatus ? { gitWorkingTreeStatus } : {}),
    ...(gitStagedStatus ? { gitStagedStatus } : {}),
  };
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * Records are NUL-terminated. A normal record is `XY <path>`. Rename/copy
 * records (`R`/`C` in either column) are followed by an extra NUL-separated
 * record holding the original path, which is retained for HEAD lookups.
 */
function parsePorcelainZ(raw: string): PorcelainEntry[] {
  const parts = raw.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (record.length < 3) continue;
    const x = record[0];
    const y = record[1];
    // Skip the "XY " prefix (status pair + single space) to get the path.
    const path = record.slice(3);
    const hasOriginalPath = x === 'R' || y === 'R' || x === 'C' || y === 'C';
    // With `-z`, rename/copy records contain the current path first and the
    // original path in the following NUL-delimited field.
    const originalPath = hasOriginalPath ? parts[++i] : undefined;
    entries.push({ x, y, path, originalPath });
  }
  return entries;
}

/**
 * Collapse every porcelain record for a path into the status presented by the
 * file browser. Git can emit more than one record for a path (for example a
 * staged deletion followed by an untracked recreation), so callers must also
 * supply whether current working-tree bytes exist.
 */
function resolvePorcelainEntries(
  entries: PorcelainEntry[],
  exists: boolean
): ResolvedPorcelainEntry | null {
  const dimensions = resolveStatusDimensions(entries);
  const classified = entries.flatMap((entry) => {
    const gitStatus = classifyPorcelain(entry.x, entry.y);
    return gitStatus ? [{ entry, gitStatus }] : [];
  });

  // Conflicts remain conflicts even when the unresolved path is absent.
  const conflict = classified.find(({ gitStatus }) => gitStatus === 'conflicted');
  if (conflict) {
    return {
      gitStatus: 'conflicted',
      ...dimensions,
      ...(conflict.entry.originalPath ? { originalPath: conflict.entry.originalPath } : {}),
    };
  }

  if (exists) {
    // A record describing present bytes wins over an index-only deletion. In
    // particular, Git reports a staged-delete/recreate pair as `D ` + `??`.
    let present: (typeof classified)[number] | undefined;
    for (let i = classified.length - 1; i >= 0; i--) {
      if (classified[i].gitStatus !== 'deleted') {
        present = classified[i];
        break;
      }
    }
    if (present) {
      return {
        gitStatus: present.gitStatus,
        ...dimensions,
        ...(present.entry.originalPath ? { originalPath: present.entry.originalPath } : {}),
      };
    }

    // Status and lstat are separate operations, so a path may be recreated
    // after Git reports it deleted. Never apply missing-file UI behavior to
    // bytes that are present; compare them with HEAD as a modification.
    if (classified.some(({ gitStatus }) => gitStatus === 'deleted')) {
      return { gitStatus: 'modified', ...dimensions };
    }
    return null;
  }

  // Working-tree deletion is the visible state even when the index also says
  // modified or renamed (`MD` / `RD`). Retain rename provenance for HEAD.
  const workingTreeDeletion = classified.find(({ entry }) => entry.y === 'D');
  if (workingTreeDeletion) {
    return {
      gitStatus: 'deleted',
      ...dimensions,
      ...(workingTreeDeletion.entry.originalPath
        ? { originalPath: workingTreeDeletion.entry.originalPath }
        : {}),
    };
  }

  const resolved = classified.at(-1);
  if (!resolved) return null;
  return {
    gitStatus: resolved.gitStatus,
    ...dimensions,
    ...(resolved.entry.originalPath ? { originalPath: resolved.entry.originalPath } : {}),
  };
}

async function readGitStatus(root: string): Promise<PorcelainEntry[] | null> {
  try {
    const { git } = createGit(root);
    const raw = await git.raw([
      '-c',
      `safe.directory=${root}`,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ]);
    return parsePorcelainZ(raw);
  } catch (error) {
    console.warn(
      `[branch.files.browse] Skipping git status for ${root}:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Compute per-file working-tree git status for the branch and merge it into
 * the browsed file list. Best-effort: any failure (non-git dir, dubious
 * ownership, git error) leaves the file list untouched.
 *
 * On-disk files gain a `gitStatus`; files git reports as deleted (and not
 * present in the walk) are appended as synthetic entries so source-control
 * views can show them even though the regular file browser omits them.
 */
async function applyGitStatus(root: string, files: FileListItem[]): Promise<void> {
  const entries = await readGitStatus(root);
  if (!entries) return;

  const byPath = new Map<string, FileListItem>();
  for (const file of files) byPath.set(file.path, file);

  const entriesByPath = new Map<string, PorcelainEntry[]>();
  for (const entry of entries) {
    const pathEntries = entriesByPath.get(entry.path) ?? [];
    pathEntries.push(entry);
    entriesByPath.set(entry.path, pathEntries);
  }

  const ignoredDirs: string[] = [];
  const deletedPaths = new Set<string>();

  for (const [path, pathEntries] of entriesByPath) {
    const existing = byPath.get(path);
    const resolved = resolvePorcelainEntries(pathEntries, existing !== undefined);
    if (!resolved) continue;

    // Git collapses a fully-ignored directory into a single `dir/` record;
    // remember it so we can tag any browsed files that live underneath it.
    if (resolved.gitStatus === 'ignored' && path.endsWith('/')) {
      ignoredDirs.push(path);
      continue;
    }

    if (existing) {
      existing.gitStatus = resolved.gitStatus;
      existing.gitWorkingTreeStatus = resolved.gitWorkingTreeStatus;
      existing.gitStagedStatus = resolved.gitStagedStatus;
    } else if (resolved.gitStatus === 'deleted') {
      deletedPaths.add(path);
    }
  }

  if (ignoredDirs.length > 0) {
    for (const file of files) {
      if (file.gitStatus) continue;
      if (ignoredDirs.some((dir) => file.path.startsWith(dir))) {
        file.gitStatus = 'ignored';
        file.gitWorkingTreeStatus = 'ignored';
      }
    }
  }

  // Surface deletions as synthetic entries (they are absent from the walk).
  // Skip anything under an excluded directory to match the browse filter.
  for (const path of deletedPaths) {
    if (files.length >= MAX_FILES) break;
    if (path.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part))) continue;
    const resolved = resolvePorcelainEntries(entriesByPath.get(path) ?? [], false);
    files.push({
      path,
      title: basename(path),
      size: 0,
      lastModified: '',
      isText: isTextFile(path, 0),
      mimeType: getMimeType(path),
      gitStatus: 'deleted',
      ...(resolved?.gitWorkingTreeStatus
        ? { gitWorkingTreeStatus: resolved.gitWorkingTreeStatus }
        : {}),
      ...(resolved?.gitStagedStatus ? { gitStagedStatus: resolved.gitStagedStatus } : {}),
    });
  }
}

export async function browseBranchFiles(branchRoot: string): Promise<FileListItem[]> {
  const root = await realpath(branchRoot);
  const files: FileListItem[] = [];
  await scanDirectory(root, root, files);
  await applyGitStatus(root, files);
  return files;
}

function normalizedRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) throw new Error('File path required');
  if (normalized.includes('\0')) throw new Error('Invalid file path');
  return normalized;
}

async function readGitText(
  root: string,
  object: string,
  displayPath: string
): Promise<{ content: string; size: number } | null> {
  try {
    const { git } = createGit(root);
    const safeDirectoryArgs = ['-c', `safe.directory=${root}`];
    const sizeOutput = await git.raw([...safeDirectoryArgs, 'cat-file', '-s', object]);
    const size = Number.parseInt(sizeOutput.trim(), 10);
    if (!Number.isFinite(size) || !isTextFile(displayPath, size)) return null;
    const content = await git.raw([...safeDirectoryArgs, 'show', object]);
    return { content, size };
  } catch {
    // Missing HEAD/index entries and non-previewable objects are normal for
    // added and deleted source-control states.
    return null;
  }
}

async function readHeadText(
  root: string,
  filePath: string
): Promise<{ content: string; size: number } | null> {
  return readGitText(root, `HEAD:${filePath}`, filePath);
}

async function readIndexText(
  root: string,
  filePath: string
): Promise<{ content: string; size: number } | null> {
  return readGitText(root, `:${filePath}`, filePath);
}

export async function readBranchFile(
  branchRoot: string,
  relativeFilePath: string,
  gitStatusSource: GitFileStatusSource = 'combined'
): Promise<FileDetail> {
  const filePath = normalizedRelativePath(relativeFilePath);
  const { absolute: requestedPath } = await resolvePathInsideBranch(branchRoot, filePath, {
    mustExist: false,
  });

  let stats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    stats = await lstat(requestedPath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }

  if (stats?.isSymbolicLink()) throw new Error('Access denied: symlinks not allowed');
  if (stats && !stats.isFile()) throw new Error('Requested path is not a file');

  const statusEntries = await readGitStatus(branchRoot);
  const resolvedStatus = resolvePorcelainEntries(
    statusEntries?.filter((entry) => entry.path === filePath) ?? [],
    stats !== null
  );
  const gitStatus = resolvedStatus?.gitStatus ?? null;
  const statusDimensions = {
    ...(resolvedStatus?.gitWorkingTreeStatus
      ? { gitWorkingTreeStatus: resolvedStatus.gitWorkingTreeStatus }
      : {}),
    ...(resolvedStatus?.gitStagedStatus ? { gitStagedStatus: resolvedStatus.gitStagedStatus } : {}),
  };

  if (gitStatusSource === 'staged') {
    const stagedStatus = resolvedStatus?.gitStagedStatus;
    if (!stagedStatus) throw new Error('Requested file has no staged change');

    const index = stagedStatus === 'deleted' ? null : await readIndexText(branchRoot, filePath);
    if (stagedStatus !== 'deleted' && !index) {
      throw new Error('Staged file is not previewable as text');
    }

    const basePath = resolvedStatus?.originalPath ?? filePath;
    const base =
      stagedStatus === 'added'
        ? { content: '', size: 0 }
        : await readHeadText(branchRoot, basePath);
    return {
      path: filePath,
      title: basename(filePath),
      size: index?.size ?? 0,
      lastModified: stats?.mtime.toISOString() ?? '',
      isText: true,
      mimeType: getMimeType(filePath),
      gitStatus: stagedStatus,
      ...statusDimensions,
      content: index?.content ?? '',
      encoding: 'utf-8',
      ...(base
        ? {
            gitDiff: {
              baseContent: base.content,
              ...(resolvedStatus?.originalPath ? { basePath: resolvedStatus.originalPath } : {}),
            },
          }
        : {}),
    };
  }

  if (gitStatusSource === 'workingTree') {
    const workingTreeStatus = resolvedStatus?.gitWorkingTreeStatus;
    if (!workingTreeStatus || workingTreeStatus === 'ignored') {
      throw new Error('Requested file has no working-tree change');
    }

    let current: { content: string; size: number } | null = null;
    if (stats) {
      if (!isTextFile(filePath, stats.size)) {
        throw new Error('Working-tree file is not previewable as text');
      }
      current = { content: (await readFile(requestedPath)).toString('utf-8'), size: stats.size };
    }

    const base =
      workingTreeStatus === 'added' || workingTreeStatus === 'untracked'
        ? { content: '', size: 0 }
        : await readIndexText(branchRoot, filePath);
    return {
      path: filePath,
      title: basename(filePath),
      size: current?.size ?? 0,
      lastModified: stats?.mtime.toISOString() ?? '',
      isText: true,
      mimeType: getMimeType(filePath),
      gitStatus: workingTreeStatus,
      ...statusDimensions,
      content: current?.content ?? '',
      encoding: 'utf-8',
      ...(base ? { gitDiff: { baseContent: base.content } } : {}),
    };
  }

  // A deleted file has no working-tree bytes, but its HEAD content is still
  // useful (and necessary) for a source-control diff preview.
  if (!stats) {
    if (gitStatus !== 'deleted') throw new Error('Requested file does not exist');
    const base = await readHeadText(branchRoot, resolvedStatus?.originalPath ?? filePath);
    if (!base) throw new Error('Deleted file is not previewable as text');
    return {
      path: filePath,
      title: basename(filePath),
      size: 0,
      lastModified: '',
      isText: true,
      mimeType: getMimeType(filePath),
      gitStatus,
      ...statusDimensions,
      content: '',
      encoding: 'utf-8',
      gitDiff: {
        baseContent: base.content,
        ...(resolvedStatus?.originalPath ? { basePath: resolvedStatus.originalPath } : {}),
      },
    };
  }

  const isText = isTextFile(filePath, stats.size);
  const buffer = await readFile(requestedPath);
  const content = buffer.toString(isText ? 'utf-8' : 'base64');
  const detail: FileDetail = {
    path: filePath,
    title:
      filePath.endsWith('.md') && isText
        ? extractTitle(content, filePath)
        : filePath.split('/').pop() || filePath,
    size: stats.size,
    lastModified: stats.mtime.toISOString(),
    isText,
    mimeType: getMimeType(filePath),
    ...(gitStatus ? { gitStatus } : {}),
    ...statusDimensions,
    content,
    encoding: isText ? 'utf-8' : 'base64',
  };

  if (isText && gitStatus && gitStatus !== 'ignored') {
    if (gitStatus === 'added' || gitStatus === 'untracked') {
      detail.gitDiff = { baseContent: '' };
    } else {
      const basePath = resolvedStatus?.originalPath ?? filePath;
      const base = await readHeadText(branchRoot, basePath);
      if (base) {
        detail.gitDiff = {
          baseContent: base.content,
          ...(resolvedStatus?.originalPath ? { basePath: resolvedStatus.originalPath } : {}),
        };
      }
    }
  }

  return detail;
}

async function withBranch<T>(
  payload: BranchFilesBrowsePayload | BranchFilesReadPayload,
  callback: (branchRoot: string) => Promise<T>
): Promise<T> {
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    return await callback(await realpath(branch.path));
  } finally {
    client?.io.disconnect();
  }
}

export async function handleBranchFilesystemStatus(
  payload: BranchFilesystemStatusPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branchIds = payload.params.branchIds ?? [payload.params.branchId!];
    const statuses = await Promise.all(
      branchIds.map(async (branchId) => {
        const branch = await resolveExecutorBranch(client!, branchId);
        return {
          branchId: branch.branch_id,
          ...(await filesystemStatus(branch.path)),
        };
      })
    );
    return {
      success: true,
      data: payload.params.branchId ? statuses[0] : { statuses },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BRANCH_FILESYSTEM_STATUS_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    try {
      client?.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}

export async function handleBranchFilesBrowse(
  payload: BranchFilesBrowsePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  try {
    const files = await withBranch(payload, browseBranchFiles);
    return { success: true, data: { files } };
  } catch (error) {
    return {
      success: false,
      error: { code: 'BRANCH_FILES_BROWSE_FAILED', message: String(error) },
    };
  }
}

export async function handleBranchFilesRead(
  payload: BranchFilesReadPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  try {
    const file = await withBranch(payload, (root) =>
      readBranchFile(root, payload.params.filePath, payload.params.gitStatusSource)
    );
    return { success: true, data: { file } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: { code: 'BRANCH_FILES_READ_FAILED', message } };
  }
}
