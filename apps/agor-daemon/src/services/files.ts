/**
 * Files Service
 *
 * Provides file and folder autocomplete search for session branches.
 * Delegates git ls-files to the executor so the daemon does not run git in a
 * managed branch checkout.
 */

import { BranchRepository, type Database, SessionRepository, UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, SessionID, UserID } from '@agor/core/types';
import { resolveExecutorReadAsUser } from '../utils/executor-read-impersonation.js';
import {
  generateScopedServiceToken,
  getDaemonUrl,
  runExecutorCommand,
} from '../utils/spawn-executor.js';

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

function isFileResultArray(value: unknown): value is FileResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof (item as FileResult).path === 'string' &&
        ((item as FileResult).type === 'file' || (item as FileResult).type === 'folder')
    )
  );
}

function extractResults(data: unknown): FileResult[] {
  if (!data || typeof data !== 'object') return [];
  const results = (data as { results?: unknown }).results;
  return isFileResultArray(results) ? results : [];
}

/**
 * Files service for autocomplete search
 */
export class FilesService {
  private sessionRepo: SessionRepository;
  private branchRepo: BranchRepository;
  private usersRepo: UsersRepository;

  constructor(
    private db: Database,
    private app: Application
  ) {
    this.sessionRepo = new SessionRepository(db);
    this.branchRepo = new BranchRepository(db);
    this.usersRepo = new UsersRepository(db);
  }

  /**
   * Search files and folders in a session's branch
   *
   * Query params:
   * - sessionId: Session ID
   * - search: Search query string (case-insensitive substring match)
   *
   * Returns array of file and folder results (folders first), max 10 items total
   */
  async find(
    params: { query: FileSearchQuery } & Partial<AuthenticatedParams>
  ): Promise<FileResult[]> {
    const { sessionId, search } = params.query;

    // Empty search returns no results
    if (!search || search.trim() === '') {
      return [];
    }

    try {
      // Fetch session to get branch_id
      const session = await this.sessionRepo.findById(sessionId);
      if (!session) {
        return [];
      }

      // Fetch branch to validate it still exists before crossing the executor boundary.
      const branch = await this.branchRepo.findById(session.branch_id);
      if (!branch?.path) {
        return [];
      }

      const sessionToken = generateScopedServiceToken(
        this.app as unknown as { settings: { authentication?: { secret?: string } } },
        params
      );

      const currentUserId = params.user?.user_id as UserID | undefined;
      const currentUser = currentUserId ? await this.usersRepo.findById(currentUserId) : null;

      const result = await runExecutorCommand(
        {
          command: 'branch.files.list',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            branchId: branch.branch_id,
            search,
            limit: MAX_FILE_RESULTS,
          },
        },
        {
          logPrefix: `[FilesService ${sessionId}]`,
          // In strict mode, autocomplete runs as the requesting Unix user.
          // In simple/insulated mode this stays undefined so default installs
          // do not require sudo and configured executor defaults can apply.
          asUser: await resolveExecutorReadAsUser(this.db, currentUser ?? currentUserId),
        }
      );

      if (!result.success) {
        console.warn(
          `Executor file search failed for session ${sessionId}: ${result.error?.message ?? 'unknown error'}`
        );
        return [];
      }

      return extractResults(result.data);
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
export function createFilesService(db: Database, app: Application): FilesService {
  return new FilesService(db, app);
}
