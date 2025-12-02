/**
 * File Service
 *
 * Provides read-only REST + WebSocket API for browsing all files in a worktree.
 * Does not use database - reads directly from filesystem.
 *
 * Configuration:
 * - Scans entire worktree path when worktree_id is provided
 * - Recursively finds all files (excluding node_modules, .git, etc.)
 * - Applies 50k file hard limit to prevent browser crashes
 * - Detects text files for preview vs download
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { WorktreeRepository } from '@agor/core/db';
import type { FileDetail, FileListItem, Id, QueryParams, ServiceMethods } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

const MAX_FILES = 50000; // Hard limit to prevent browser crashes
const MAX_PREVIEW_SIZE = 1024 * 1024; // 1MB max file size for preview

/**
 * File service params (read-only, no create/update/delete)
 */
export type FileParams = QueryParams<{
  worktree_id?: string;
}>;

/**
 * Check if file should be previewable as text
 */
function isTextFile(filePath: string, size: number): boolean {
  // Size limit: 1MB for preview
  if (size > MAX_PREVIEW_SIZE) return false;

  const lowerPath = filePath.toLowerCase();

  // Exclude lock files and other files that are too large/not useful to preview
  const excludeFiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
  ];

  const fileName = lowerPath.split('/').pop() || '';
  if (excludeFiles.includes(fileName)) {
    return false;
  }

  const textExtensions = [
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
  ];

  return textExtensions.some((ext) => lowerPath.endsWith(ext));
}

/**
 * Detect MIME type from file extension
 */
function getMimeType(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
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
  };
  return mimeTypes[ext];
}

/**
 * File service - read-only filesystem browser for worktree files
 */
export class FileService
  implements Pick<ServiceMethods<FileListItem | FileDetail>, 'find' | 'get' | 'setup' | 'teardown'>
{
  private worktreeRepo: WorktreeRepository;

  constructor(worktreeRepo: WorktreeRepository) {
    this.worktreeRepo = worktreeRepo;
  }

  /**
   * Find all files in worktree (GET /file?worktree_id=xxx)
   * Returns lightweight list items without content
   */
  async find(params?: FileParams): Promise<FileListItem[]> {
    ensureMinimumRole(params, 'member', 'list files');

    const worktreeId = params?.query?.worktree_id;

    if (!worktreeId) {
      throw new Error('worktree_id query parameter is required');
    }

    // Get worktree to find its path
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    console.log('[File Service] Scanning worktree:', {
      worktree_id: worktree.worktree_id,
      name: worktree.name,
      path: worktree.path,
    });

    const files: FileListItem[] = [];

    // Scan entire worktree
    await this.scanDirectory(worktree.path, worktree.path, files);

    // Apply hard limit to prevent browser crashes
    if (files.length > MAX_FILES) {
      console.warn(
        `[File Service] Repository has ${files.length} files, truncating to ${MAX_FILES}`
      );
      const truncated = files.slice(0, MAX_FILES);
      console.log(`[File Service] Returning ${truncated.length} files (truncated)`);
      return truncated;
    }

    console.log(`[File Service] Found ${files.length} files`);
    return files;
  }

  /**
   * Get specific file (GET /file/:path?worktree_id=xxx)
   * Returns full details with content
   *
   * @param id - Relative path from worktree root (e.g., "src/index.ts", "README.md")
   */
  async get(id: Id, params?: FileParams): Promise<FileDetail> {
    ensureMinimumRole(params, 'member', 'read file');

    const worktreeId = params?.query?.worktree_id;

    if (!worktreeId) {
      throw new Error('worktree_id query parameter is required');
    }

    // Get worktree to find its path
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    const relativePathInput = id.toString();
    const normalizedRelativePath = this.normalizeRelativePath(relativePathInput);

    const worktreeRoot = resolve(worktree.path);
    const fullPath = resolve(worktreeRoot, normalizedRelativePath);
    const relativeToRoot = relative(worktreeRoot, fullPath);

    // Validate path is within worktree
    if (!relativeToRoot || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      throw new Error('Invalid file path');
    }

    try {
      // Read file content
      const content = await readFile(fullPath, 'utf-8');

      // Get file stats
      const stats = await stat(fullPath);

      // Determine if text file
      const isText = isTextFile(normalizedRelativePath, stats.size);

      // Extract title from first H1 for markdown, otherwise use filename
      const title = normalizedRelativePath.endsWith('.md')
        ? this.extractTitle(content, normalizedRelativePath)
        : normalizedRelativePath.split('/').pop() || normalizedRelativePath;

      return {
        path: normalizedRelativePath,
        title,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        isText,
        mimeType: getMimeType(normalizedRelativePath),
        content,
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  }

  /**
   * Recursively scan directory for all files
   */
  private async scanDirectory(
    baseDir: string,
    currentDir: string,
    files: FileListItem[],
    excludePatterns: string[] = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'coverage',
      '__pycache__',
      '.venv',
      'venv',
    ]
  ): Promise<void> {
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relativePath = relative(baseDir, fullPath);

        // Skip excluded directories
        const pathParts = relativePath.split('/');
        if (excludePatterns.some((pattern) => pathParts.includes(pattern))) {
          continue;
        }

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await this.scanDirectory(baseDir, fullPath, files, excludePatterns);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          const isText = isTextFile(relativePath, stats.size);

          // Extract title for markdown files
          let title = entry.name;
          if (relativePath.endsWith('.md')) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              title = this.extractTitle(content, relativePath);
            } catch {
              // If can't read, use filename
              title = entry.name;
            }
          }

          files.push({
            path: relativePath,
            title,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
            isText,
            mimeType: getMimeType(relativePath),
          });

          // Early exit if we've hit the limit
          if (files.length >= MAX_FILES) {
            return;
          }
        }
      }
    } catch (_error) {
      // Directory access error, skip silently
    }
  }

  /**
   * Normalize relative path input, preventing traversal characters.
   */
  private normalizeRelativePath(pathFragment: string): string {
    const normalized = pathFragment.replace(/\\/g, '/').replace(/^\/+/, '').trim();

    if (!normalized) {
      throw new Error('File path required');
    }

    if (normalized.includes('\0')) {
      throw new Error('Invalid file path');
    }

    return normalized;
  }

  /**
   * Extract title from markdown content (first H1) or fallback to filename
   */
  private extractTitle(content: string, relativePath: string): string {
    // Try to extract first H1 heading
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      return h1Match[1].trim();
    }

    // Fallback to filename without extension
    const filename = relativePath.split('/').pop() || relativePath;
    return filename.replace(/\.md$/, '');
  }

  async setup(): Promise<void> {
    // No setup needed
  }

  async teardown(): Promise<void> {
    // No teardown needed
  }
}

/**
 * Service factory function
 */
export function createFileService(worktreeRepo: WorktreeRepository): FileService {
  return new FileService(worktreeRepo);
}
