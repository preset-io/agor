/**
 * Files Service
 *
 * Provides file and folder autocomplete search for session worktrees.
 * Uses git ls-files to search tracked files and extracts folders from file paths.
 * Results are filtered by substring match (case-insensitive).
 */

import { type Database, SessionRepository, WorktreeRepository } from '@agor/core/db';
import { simpleGit } from '@agor/core/git';
import type { SessionID } from '@agor/core/types';

// Constants for file search
const MAX_FILE_RESULTS = 10;
const _MAX_USER_RESULTS = 5;

interface FileSearchQuery {
  sessionId: SessionID;
  search: string;
}

interface FileResult {
  path: string;
  type: 'file' | 'folder';
}

/**
 * Files service for autocomplete search
 */
export class FilesService {
  private sessionRepo: SessionRepository;
  private worktreeRepo: WorktreeRepository;

  constructor(db: Database) {
    this.sessionRepo = new SessionRepository(db);
    this.worktreeRepo = new WorktreeRepository(db);
  }

  /**
   * Search files and folders in a session's worktree
   *
   * Query params:
   * - sessionId: Session ID
   * - search: Search query string (case-insensitive substring match)
   *
   * Returns array of file and folder results (folders first), max 10 items total
   */
  async find(params: { query: FileSearchQuery }): Promise<FileResult[]> {
    const { sessionId, search } = params.query;

    // Empty search returns no results
    if (!search || search.trim() === '') {
      return [];
    }

    try {
      // Fetch session to get worktree_id
      const session = await this.sessionRepo.findById(sessionId);
      if (!session) {
        return [];
      }

      // Fetch worktree to get path
      const worktree = await this.worktreeRepo.findById(session.worktree_id);
      if (!worktree || !worktree.path) {
        return [];
      }

      // Run git ls-files
      const git = simpleGit(worktree.path);
      let result: string;

      try {
        result = await git.raw(['ls-files', '-z']);
      } catch (error) {
        // Handle "dubious ownership" error on Linux by adding to safe.directory
        if (error instanceof Error && error.message.includes('dubious ownership')) {
          console.log(`Adding ${worktree.path} to git safe.directory`);
          await git.addConfig('safe.directory', worktree.path, true, 'global');
          // Retry the ls-files command
          result = await git.raw(['ls-files', '-z']);
        } else {
          throw error;
        }
      }

      // Parse null-separated file list
      const allFiles = result.split('\0').filter((f) => f.length > 0);

      // Extract unique folders from file paths
      const foldersSet = new Set<string>();
      allFiles.forEach((filePath) => {
        const parts = filePath.split('/');
        // Build up folder paths (e.g., "src", "src/components", etc.)
        for (let i = 1; i < parts.length; i++) {
          foldersSet.add(parts.slice(0, i).join('/'));
        }
      });

      // Filter files and folders by search query
      const searchLower = search.toLowerCase();

      const matchingFiles = allFiles
        .filter((f) => f.toLowerCase().includes(searchLower))
        .map((path) => ({ path, type: 'file' as const }));

      // Add trailing slash first, then filter so searches like "context/" work
      const matchingFolders = Array.from(foldersSet)
        .map((path) => `${path}/`)
        .filter((f) => f.toLowerCase().includes(searchLower))
        .map((path) => ({ path, type: 'folder' as const }));

      // Combine and sort: folders first, then files
      const combined = [...matchingFolders, ...matchingFiles].slice(0, MAX_FILE_RESULTS);

      return combined;
    } catch (error) {
      // Log error but return empty array (don't block UX)
      console.error(`Error searching files for session ${sessionId}:`, error);
      return [];
    }
  }
}

/**
 * Service factory function
 */
export function createFilesService(db: Database): FilesService {
  return new FilesService(db);
}
