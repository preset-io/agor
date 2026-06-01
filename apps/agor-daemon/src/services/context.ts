/**
 * Context Service
 *
 * @deprecated This service is deprecated. Use the 'file' service instead, which supports
 * browsing all files in a branch, not just markdown files in context/.
 *
 * Provides read-only REST + WebSocket API for browsing markdown files in branch context/ directories.
 * Does not use database - reads directly from filesystem.
 *
 * Configuration:
 * - Scans context/ folder from branch path when branch_id is provided
 * - Recursively finds all .md files in context/ and subdirectories
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BranchRepository } from '@agor/core/db';
import type {
  ContextFileDetail,
  ContextFileListItem,
  Id,
  QueryParams,
  ServiceMethods,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

/**
 * Context service params (read-only, no create/update/delete)
 */
export type ContextParams = QueryParams<{
  branch_id?: string;
}>;

/**
 * Context service - read-only filesystem browser for branch concept files
 */
export class ContextService
  implements
    Pick<
      ServiceMethods<ContextFileListItem | ContextFileDetail>,
      'find' | 'get' | 'setup' | 'teardown'
    >
{
  private branchRepo: BranchRepository;

  constructor(branchRepo: BranchRepository) {
    this.branchRepo = branchRepo;
  }

  /**
   * Find all markdown files (GET /context?branch_id=xxx)
   * Returns lightweight list items without content
   *
   * @deprecated Use the 'file' service instead
   */
  async find(params?: ContextParams): Promise<ContextFileListItem[]> {
    console.warn(
      '[Context Service] DEPRECATED: This service is deprecated. Use /file endpoint instead for browsing all files in a branch.'
    );

    ensureMinimumRole(params, ROLES.MEMBER, 'list context files');

    const branchId = params?.query?.branch_id;

    if (!branchId) {
      throw new Error('branch_id query parameter is required');
    }

    // Get branch to find its path
    const branch = await this.branchRepo.findById(branchId);
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }

    console.log('[Context Service] Branch:', {
      branch_id: branch.branch_id,
      name: branch.name,
      path: branch.path,
    });

    const files: ContextFileListItem[] = [];

    // Scan context/ directory
    await this.scanDirectory(branch.path, 'context', files);

    console.log('[Context Service] Found files:', files.length);

    return files;
  }

  /**
   * Get specific markdown file (GET /context/:path?branch_id=xxx)
   * Returns full details with content
   *
   * @param id - Relative path from branch root (e.g., "context/concepts/core.md", "CLAUDE.md")
   */
  async get(id: Id, params?: ContextParams): Promise<ContextFileDetail> {
    ensureMinimumRole(params, ROLES.MEMBER, 'read context file');

    const branchId = params?.query?.branch_id;

    if (!branchId) {
      throw new Error('branch_id query parameter is required');
    }

    // Get branch to find its path
    const branch = await this.branchRepo.findById(branchId);
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }

    const relativePathInput = id.toString();
    const normalizedRelativePath = this.normalizeRelativePath(relativePathInput);

    const branchRoot = resolve(branch.path);
    const fullPath = resolve(branchRoot, normalizedRelativePath);
    const relativeToRoot = relative(branchRoot, fullPath);

    // Validate path is within branch and starts with context/
    if (!relativeToRoot || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      throw new Error('Invalid file path');
    }

    if (!relativeToRoot.startsWith('context/')) {
      throw new Error('Access restricted to context/ directory');
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
export function createContextService(branchRepo: BranchRepository): ContextService {
  return new ContextService(branchRepo);
}
