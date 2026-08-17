import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { FileDetail, FileListItem } from '@agor/core/types';
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
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webm': 'video/webm',
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

export async function browseBranchFiles(branchRoot: string): Promise<FileListItem[]> {
  const root = await realpath(branchRoot);
  const files: FileListItem[] = [];
  await scanDirectory(root, root, files);
  return files;
}

function normalizedRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) throw new Error('File path required');
  if (normalized.includes('\0')) throw new Error('Invalid file path');
  return normalized;
}

export async function readBranchFile(
  branchRoot: string,
  relativeFilePath: string
): Promise<FileDetail> {
  const filePath = normalizedRelativePath(relativeFilePath);
  const { absolute: requestedPath } = await resolvePathInsideBranch(branchRoot, filePath, {
    mustExist: true,
  });
  const stats = await lstat(requestedPath);
  if (stats.isSymbolicLink()) throw new Error('Access denied: symlinks not allowed');
  if (!stats.isFile()) throw new Error('Requested path is not a file');
  const isText = isTextFile(filePath, stats.size);
  const buffer = await readFile(requestedPath);
  const content = buffer.toString(isText ? 'utf-8' : 'base64');
  return {
    path: filePath,
    title:
      filePath.endsWith('.md') && isText
        ? extractTitle(content, filePath)
        : filePath.split('/').pop() || filePath,
    size: stats.size,
    lastModified: stats.mtime.toISOString(),
    isText,
    mimeType: getMimeType(filePath),
    content,
    encoding: isText ? 'utf-8' : 'base64',
  };
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
