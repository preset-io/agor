/**
 * Files Service
 *
 * Provides file autocomplete search for session worktrees.
 * Uses git ls-files to search tracked files by substring match.
 */

import { type Database, SessionRepository, WorktreeRepository } from '@agor/core/db';
import { simpleGit } from '@agor/core/git';
import type { SessionID } from '@agor/core/types';

// Constants for file search
const MAX_FILE_RESULTS = 10;
const MAX_USER_RESULTS = 5;

interface FileSearchQuery {
  sessionId: SessionID;
  search: string;
}

interface FileResult {
  path: string;
  type: 'file';
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
   * Search files in a session's worktree
   *
   * Query params:
   * - sessionId: Session ID
   * - search: Search query string (case-insensitive substring match)
   *
   * Returns array of file results, max 10 items
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
      const result = await git.raw(['ls-files', '-z']);

      // Parse null-separated file list
      const files = result
        .split('\0')
        .filter((f) => f.length > 0)
        .filter((f) => f.toLowerCase().includes(search.toLowerCase()))
        .slice(0, MAX_FILE_RESULTS)
        .map((path) => ({ path, type: 'file' as const }));

      return files;
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
