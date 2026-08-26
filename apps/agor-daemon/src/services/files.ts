/**
 * Files Service
 *
 * Provides file and folder autocomplete search for session branches.
 * Delegates git ls-files to the executor so the daemon does not run git in a
 * managed branch checkout.
 */

import {
  BranchRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  SessionRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  RBACParams,
  SessionID,
  UserID,
  UserRole,
} from '@agor/core/types';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

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

  constructor(
    private db: TenantScopeAwareDatabase,
    private app: Application
  ) {
    this.sessionRepo = new SessionRepository(db);
    this.branchRepo = new BranchRepository(db);
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

    // Keep repository and identity reads inside a short tenant transaction.
    // The executor call below is deliberately outside this scope. Resolve the
    // identity before opening the unit of work and never turn boundary failures
    // into an empty autocomplete response.
    const tenantId = requireCurrentTenantId(
      'Missing active tenant context for files database access'
    );
    const resolved = await runWithTenantDatabaseScope(this.db, tenantId, async () => {
      const cached = params as Partial<RBACParams>;
      const session =
        cached.session?.session_id === sessionId
          ? cached.session
          : await this.sessionRepo.findById(sessionId);
      if (!session) return null;

      const branch =
        cached.branch?.branch_id === session.branch_id
          ? cached.branch
          : await this.branchRepo.findById(session.branch_id);
      if (!branch?.path) return null;

      const currentUserId = params.user?.user_id as UserID | undefined;
      if (!currentUserId) throw new NotAuthenticated('Authentication required');
      const fsAccess = await ensureBranchWorkspaceAccess(
        this.branchRepo,
        branch,
        currentUserId,
        params.user?.role as UserRole | undefined,
        'view',
        'read',
        this.app.get('config').execution?.allow_superadmin === true
      );
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        currentUserId,
        this.app.get('config')
      );
      return {
        branchId: branch.branch_id,
        branchPath: branch.path,
        delegatedHomeKey,
        fsAccess,
        userId: currentUserId,
      };
    });
    if (!resolved) return [];

    try {
      const sessionToken = await issueExecutorCommandToken(
        this.app,
        'branch-files-list',
        resolved.userId,
        resolved.branchId
      );

      const result = await requestExecutor(
        {
          command: 'branch.files.list',
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: {
            branchId: resolved.branchId,
            search,
            limit: MAX_FILE_RESULTS,
            cwd: resolved.branchPath,
            principalBranchAccess: resolved.fsAccess,
          },
        },
        {
          logPrefix: `[FilesService ${sessionId}]`,
          // Delegated mode passes the caller's stable execution-home key to
          // the external launcher. Local modes do not select a host identity.
          delegatedHomeKey: resolved.delegatedHomeKey,
          templateVariables: {
            branch_id: resolved.branchId,
            user_id: resolved.userId,
            branch_fs_access: resolved.fsAccess,
          },
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
export function createFilesService(db: TenantScopeAwareDatabase, app: Application): FilesService {
  return new FilesService(db, app);
}
