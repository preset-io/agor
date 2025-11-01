/**
 * Context Service
 *
 * Provides read-only REST + WebSocket API for browsing markdown files in worktree context/ directories.
 * Does not use database - reads directly from filesystem.
 *
 * Configuration:
 * - Scans context/ folder from worktree path when worktree_id is provided
 * - Recursively finds all .md files in context/ and subdirectories
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { WorktreeRepository } from '@agor/core/db';
import type {
  ContextFileDetail,
  ContextFileListItem,
  Id,
  QueryParams,
  ServiceMethods,
} from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

/**
 * Context service params (read-only, no create/update/delete)
 */
export type ContextParams = QueryParams<{
  worktree_id?: string;
}>;

/**
 * Context service - read-only filesystem browser for worktree concept files
 */
export class ContextService
  implements
    Pick<
      ServiceMethods<ContextFileListItem | ContextFileDetail>,
      'find' | 'get' | 'setup' | 'teardown'
    >
{
  private worktreeRepo: WorktreeRepository;

  constructor(worktreeRepo: WorktreeRepository) {
    this.worktreeRepo = worktreeRepo;
  }

  /**
   * Find all markdown files (GET /context?worktree_id=xxx)
   * Returns lightweight list items without content
   */
  async find(params?: ContextParams): Promise<ContextFileListItem[]> {
    ensureMinimumRole(params, 'member', 'list context files');

    const worktreeId = params?.query?.worktree_id;

    if (!worktreeId) {
      throw new Error('worktree_id query parameter is required');
    }

    // Get worktree to find its path
    const worktree = await this.worktreeRepo.findById(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    console.log('[Context Service] Worktree:', {
      worktree_id: worktree.worktree_id,
      name: worktree.name,
      path: worktree.path,
    });

    const files: ContextFileListItem[] = [];

    // Scan context/ directory
    await this.scanDirectory(worktree.path, 'context', files);

    console.log('[Context Service] Found files:', files.length);

    return files;
  }

  /**
   * Get specific markdown file (GET /context/:path?worktree_id=xxx)
   * Returns full details with content
   *
   * @param id - Relative path from worktree root (e.g., "context/concepts/core.md", "CLAUDE.md")
   */
  async get(id: Id, params?: ContextParams): Promise<ContextFileDetail> {
    ensureMinimumRole(params, 'member', 'read context file');

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
    const segments = normalizedRelativePath.split('/').filter(Boolean);

    // Restrict access to context/ directory only
    if (segments[0] !== 'context') {
      throw new Error('Access restricted to context/ directory');
    }

    const worktreeRoot = resolve(worktree.path);
    const fullPath = resolve(worktreeRoot, normalizedRelativePath);
    const relativeToRoot = relative(worktreeRoot, fullPath);

    if (!relativeToRoot || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      throw new Error('Invalid file path');
    }

    try {
      // Read file content
      const content = await readFile(fullPath, 'utf-8');

      // Get file stats
      const stats = await stat(fullPath);

      // Extract title from first H1 or filename
      const title = this.extractTitle(content, normalizedRelativePath);

      return {
        path: normalizedRelativePath,
        title,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        content,
      };
    } catch (error) {
      throw new Error(`Failed to read context file: ${error}`);
    }
  }

  /**
   * Recursively scan directory for markdown files
   */
  private async scanDirectory(
    basePath: string,
    relativePath: string,
    files: ContextFileListItem[]
  ): Promise<void> {
    const dirPath = join(basePath, relativePath);

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelPath = relativePath ? join(relativePath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await this.scanDirectory(basePath, entryRelPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Read markdown file metadata
          const fullPath = join(dirPath, entry.name);
          const stats = await stat(fullPath);
          const content = await readFile(fullPath, 'utf-8');
          const title = this.extractTitle(content, entryRelPath);

          files.push({
            path: entryRelPath,
            title,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
          });
        }
      }
    } catch (_error) {
      // Directory doesn't exist, ignore
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
export function createContextService(worktreeRepo: WorktreeRepository): ContextService {
  return new ContextService(worktreeRepo);
}
