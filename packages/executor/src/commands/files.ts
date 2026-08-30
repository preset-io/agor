import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { FileDetail, FileListItem, GitFileStatus } from '@agor/core/types';
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
 * present in the walk) are appended as synthetic entries so the UI can show
 * them struck-through, matching an IDE source-control view.
 */
async function applyGitStatus(root: string, files: FileListItem[]): Promise<void> {
  const entries = await readGitStatus(root);
  if (!entries) return;

  const byPath = new Map<string, FileListItem>();
  for (const file of files) byPath.set(file.path, file);

  const ignoredDirs: string[] = [];
  const deletedPaths: string[] = [];

  for (const { x, y, path } of entries) {
    const status = classifyPorcelain(x, y);
    if (!status) continue;

    // Git collapses a fully-ignored directory into a single `dir/` record;
    // remember it so we can tag any browsed files that live underneath it.
    if (status === 'ignored' && path.endsWith('/')) {
      ignoredDirs.push(path);
      continue;
    }

    const existing = byPath.get(path);
    if (existing) {
      existing.gitStatus = status;
    } else if (status === 'deleted') {
      deletedPaths.push(path);
    }
  }

  if (ignoredDirs.length > 0) {
    for (const file of files) {
      if (file.gitStatus) continue;
      if (ignoredDirs.some((dir) => file.path.startsWith(dir))) {
        file.gitStatus = 'ignored';
      }
    }
  }

  // Surface deletions as synthetic entries (they are absent from the walk).
  // Skip anything under an excluded directory to match the browse filter.
  for (const path of deletedPaths) {
    if (files.length >= MAX_FILES) break;
    if (path.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part))) continue;
    files.push({
      path,
      title: basename(path),
      size: 0,
      lastModified: '',
      isText: isTextFile(path, 0),
      mimeType: getMimeType(path),
      gitStatus: 'deleted',
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

async function readHeadText(
  root: string,
  filePath: string
): Promise<{ content: string; size: number } | null> {
  const object = `HEAD:${filePath}`;
  try {
    const { git } = createGit(root);
    const safeDirectoryArgs = ['-c', `safe.directory=${root}`];
    const sizeOutput = await git.raw([...safeDirectoryArgs, 'cat-file', '-s', object]);
    const size = Number.parseInt(sizeOutput.trim(), 10);
    if (!Number.isFinite(size) || !isTextFile(filePath, size)) return null;
    const content = await git.raw([...safeDirectoryArgs, 'show', object]);
    return { content, size };
  } catch {
    // Unborn HEAD, an index-only path, or an object that no longer exists all
    // legitimately mean that there is no committed text to compare against.
    return null;
  }
}

export async function readBranchFile(
  branchRoot: string,
  relativeFilePath: string
): Promise<FileDetail> {
  const filePath = normalizedRelativePath(relativeFilePath);
  const { absolute: requestedPath } = await resolvePathInsideBranch(branchRoot, filePath, {
    mustExist: false,
  });

  const statusEntries = await readGitStatus(branchRoot);
  const statusEntry = statusEntries?.find((entry) => entry.path === filePath);
  const gitStatus = statusEntry ? classifyPorcelain(statusEntry.x, statusEntry.y) : null;

  let stats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    stats = await lstat(requestedPath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }

  if (stats?.isSymbolicLink()) throw new Error('Access denied: symlinks not allowed');
  if (stats && !stats.isFile()) throw new Error('Requested path is not a file');

  // A deleted file has no working-tree bytes, but its HEAD content is still
  // useful (and necessary) for a source-control diff preview.
  if (!stats) {
    if (gitStatus !== 'deleted') throw new Error('Requested file does not exist');
    const base = await readHeadText(branchRoot, statusEntry?.originalPath ?? filePath);
    if (!base) throw new Error('Deleted file is not previewable as text');
    return {
      path: filePath,
      title: basename(filePath),
      size: 0,
      lastModified: '',
      isText: true,
      mimeType: getMimeType(filePath),
      gitStatus,
      content: '',
      encoding: 'utf-8',
      gitDiff: {
        baseContent: base.content,
        ...(statusEntry?.originalPath ? { basePath: statusEntry.originalPath } : {}),
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
    content,
    encoding: isText ? 'utf-8' : 'base64',
  };

  if (isText && gitStatus && gitStatus !== 'ignored') {
    if (gitStatus === 'added' || gitStatus === 'untracked') {
      detail.gitDiff = { baseContent: '' };
    } else {
      const basePath = statusEntry?.originalPath ?? filePath;
      const base = await readHeadText(branchRoot, basePath);
      if (base) {
        detail.gitDiff = {
          baseContent: base.content,
          ...(statusEntry?.originalPath ? { basePath: statusEntry.originalPath } : {}),
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
    const file = await withBranch(payload, (root) => readBranchFile(root, payload.params.filePath));
    return { success: true, data: { file } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: { code: 'BRANCH_FILES_READ_FAILED', message } };
  }
}
