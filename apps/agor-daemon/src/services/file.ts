/**
 * Read-only branch file browser. Tenant filesystem access is delegated to the executor.
 */
import {
  type BranchRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  FileDetail,
  FileListItem,
  Id,
  QueryParams,
  RBACParams,
  ServiceMethods,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';
import { resolveExecutorReadAsUser } from '../utils/executor-read-impersonation.js';
import {
  generateScopedServiceToken,
  getDaemonUrl,
  runExecutorCommand,
} from '../utils/spawn-executor.js';

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

    const result = await this.runCommand('branch.files.browse', resolved.branchId, resolved.asUser);
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

    const result = await this.runCommand('branch.files.read', resolved.branchId, resolved.asUser, {
      filePath: id.toString(),
    });
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
    asUser?: string,
    extraParams: Record<string, unknown> = {}
  ) {
    const sessionToken = generateScopedServiceToken(
      this.app as unknown as { settings: { authentication?: { secret?: string } } }
    );
    return runExecutorCommand(
      {
        command,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: { branchId, ...extraParams },
      },
      {
        logPrefix: `[FileService ${branchId}]`,
        asUser,
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
      const asUser = await resolveExecutorReadAsUser(
        this.db,
        params?.user?.user_id,
        this.app.get('config')
      );
      return { branchId: branch.branch_id, asUser };
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
