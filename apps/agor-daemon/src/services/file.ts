/**
 * Read-only branch file browser. Tenant filesystem access is delegated to the executor.
 */
import {
  type BranchRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  FileDetail,
  FileListItem,
  Id,
  QueryParams,
  RBACParams,
  ServiceMethods,
  UserRole,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

export type FileParams = QueryParams<{ branch_id?: string }> & Partial<AuthenticatedParams>;

function extractFiles(data: unknown): FileListItem[] {
  if (!data || typeof data !== 'object') return [];
  const files = (data as { files?: unknown }).files;
  return Array.isArray(files) ? (files as FileListItem[]) : [];
}

function extractFile(data: unknown): FileDetail | null {
  if (!data || typeof data !== 'object') return null;
  const file = (data as { file?: unknown }).file;
  return file && typeof file === 'object' ? (file as FileDetail) : null;
}

export class FileService
  implements Pick<ServiceMethods<FileListItem | FileDetail>, 'find' | 'get' | 'setup' | 'teardown'>
{
  constructor(
    private branchRepo: BranchRepository,
    private db: TenantScopeAwareDatabase,
    private app: Application
  ) {}

  async find(params?: FileParams): Promise<FileListItem[]> {
    ensureMinimumRole(params, ROLES.MEMBER, 'list files');
    const branchId = params?.query?.branch_id;
    if (!branchId) throw new Error('branch_id query parameter is required');
    const resolved = await this.resolveBranchRead(branchId, params);

    const result = await this.runCommand(
      'branch.files.browse',
      resolved.branchId,
      resolved.userId,
      resolved.delegatedHomeKey,
      resolved.branchPath,
      resolved.fsAccess
    );
    if (!result.success) {
      throw new Error(
        `Failed to browse files: ${result.error?.message ?? 'unknown executor error'}`
      );
    }
    return extractFiles(result.data);
  }

  async get(id: Id, params?: FileParams): Promise<FileDetail> {
    ensureMinimumRole(params, ROLES.MEMBER, 'read file');
    const branchId = params?.query?.branch_id;
    if (!branchId) throw new Error('branch_id query parameter is required');
    const resolved = await this.resolveBranchRead(branchId, params);

    const result = await this.runCommand(
      'branch.files.read',
      resolved.branchId,
      resolved.userId,
      resolved.delegatedHomeKey,
      resolved.branchPath,
      resolved.fsAccess,
      {
        filePath: id.toString(),
      }
    );
    if (!result.success) {
      throw new Error(`Failed to read file: ${result.error?.message ?? 'unknown executor error'}`);
    }
    const file = extractFile(result.data);
    if (!file) throw new Error('Failed to read file: executor returned an invalid response');
    return file;
  }

  private async runCommand(
    command: 'branch.files.browse' | 'branch.files.read',
    branchId: string,
    userId: string,
    delegatedHomeKey: string | undefined,
    branchPath: string,
    fsAccess: 'read' | 'write',
    extraParams: Record<string, unknown> = {}
  ) {
    const sessionToken = await issueExecutorCommandToken(this.app, command, userId, branchId);
    return requestExecutor(
      {
        command,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: {
          branchId,
          ...extraParams,
          cwd: branchPath,
          principalBranchAccess: fsAccess,
        },
      },
      {
        logPrefix: `[FileService ${branchId}]`,
        delegatedHomeKey: delegatedHomeKey,
        templateVariables: {
          branch_id: branchId,
          user_id: userId,
          branch_fs_access: fsAccess,
        },
      }
    );
  }

  private async resolveBranchRead(branchId: string, params?: FileParams) {
    const tenantId = requireCurrentTenantId(
      'Missing active tenant context for file database access'
    );
    return runWithTenantDatabaseScope(this.db, tenantId, async () => {
      const cachedBranch = (params as Partial<RBACParams> | undefined)?.branch;
      const branch =
        cachedBranch?.branch_id === branchId
          ? cachedBranch
          : await this.branchRepo.findById(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      const userId = params?.user?.user_id;
      if (!userId) throw new NotAuthenticated('Authentication required');
      const fsAccess = await ensureBranchWorkspaceAccess(
        this.branchRepo,
        branch,
        userId,
        params?.user?.role as UserRole | undefined,
        'view',
        'read',
        this.app.get('config').execution?.allow_superadmin === true
      );
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        userId,
        this.app.get('config')
      );
      return {
        branchId: branch.branch_id,
        branchPath: branch.path,
        delegatedHomeKey,
        fsAccess,
        userId,
      };
    });
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}
}

export function createFileService(
  branchRepo: BranchRepository,
  db: TenantScopeAwareDatabase,
  app: Application
): FileService {
  return new FileService(branchRepo, db, app);
}
