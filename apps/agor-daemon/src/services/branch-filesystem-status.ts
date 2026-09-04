import {
  type BranchRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { ExecutorCommandResult } from '@agor/core/executor-protocol';
import {
  type Application,
  BadRequest,
  Forbidden,
  NotAuthenticated,
  Unavailable,
} from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchFilesystemKind,
  BranchFilesystemObservation,
  BranchID,
  Params,
  UserRole,
} from '@agor/core/types';
import { BRANCH_FILESYSTEM_KINDS } from '@agor/core/types';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

const COMMAND = 'branch.filesystem.status';
const UNAVAILABLE_CODE = 'BRANCH_FILESYSTEM_OBSERVATION_UNAVAILABLE';

export interface BranchFilesystemStatusParams extends Params, Partial<AuthenticatedParams> {
  route?: { id?: string };
}

interface AuthorizedBranchObservation {
  branchId: BranchID;
  delegatedHomeKey?: string;
  fsAccess: 'read' | 'write';
  userId: string;
}

interface BranchFilesystemStatusDependencies {
  issueToken(app: object, commandId: string, userId: string, branchId: string): Promise<string>;
  now(): Date;
  request(
    payload: Record<string, unknown>,
    options: Parameters<typeof requestExecutor>[1]
  ): Promise<ExecutorCommandResult>;
}

const defaultDependencies: BranchFilesystemStatusDependencies = {
  issueToken: issueExecutorCommandToken,
  now: () => new Date(),
  request: requestExecutor,
};

function unavailable(): Unavailable {
  return new Unavailable('Branch filesystem observation is temporarily unavailable', {
    code: UNAVAILABLE_CODE,
  });
}

export function parseBranchFilesystemObservation(
  data: unknown,
  expectedBranchId: BranchID,
  observedAt: Date
): BranchFilesystemObservation {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'branchId' || keys[1] !== 'exists' || keys[2] !== 'kind') {
    throw unavailable();
  }
  if (record.branchId !== expectedBranchId || typeof record.exists !== 'boolean') {
    throw unavailable();
  }
  if (
    typeof record.kind !== 'string' ||
    !BRANCH_FILESYSTEM_KINDS.includes(record.kind as BranchFilesystemKind)
  ) {
    throw unavailable();
  }
  const kind = record.kind as BranchFilesystemKind;
  if ((kind === 'missing') !== !record.exists) throw unavailable();

  return {
    branch_id: expectedBranchId,
    exists: record.exists,
    kind,
    observed_at: observedAt.toISOString(),
  };
}

export class BranchFilesystemStatusService {
  private readonly dependencies: BranchFilesystemStatusDependencies;

  constructor(
    private readonly branchRepo: BranchRepository,
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    dependencies: Partial<BranchFilesystemStatusDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async find(params?: BranchFilesystemStatusParams): Promise<BranchFilesystemObservation> {
    if (params?.query && Object.keys(params.query).length > 0) {
      throw new BadRequest('Branch filesystem status does not accept query parameters');
    }
    const requestedBranchId = params?.route?.id;
    if (!requestedBranchId) throw new BadRequest('Branch ID required');

    const resolved = await this.resolveAuthorizedBranch(requestedBranchId, params);
    try {
      const sessionToken = await this.dependencies.issueToken(
        this.app,
        COMMAND,
        resolved.userId,
        resolved.branchId
      );
      const result = await this.dependencies.request(
        {
          command: COMMAND,
          sessionToken,
          daemonUrl: getDaemonUrl(),
          params: { branchId: resolved.branchId },
        },
        {
          delegatedHomeKey: resolved.delegatedHomeKey,
          logPrefix: '[BranchFilesystemStatus]',
          sensitiveOutput: true,
          templateVariables: {
            branch_id: resolved.branchId,
            user_id: resolved.userId,
            branch_fs_access: resolved.fsAccess,
          },
        }
      );
      if (!result.success) throw unavailable();
      return parseBranchFilesystemObservation(
        result.data,
        resolved.branchId,
        this.dependencies.now()
      );
    } catch {
      throw unavailable();
    }
  }

  private async resolveAuthorizedBranch(
    requestedBranchId: string,
    params?: BranchFilesystemStatusParams
  ): Promise<AuthorizedBranchObservation> {
    const userId = params?.user?.user_id;
    if (!userId) throw new NotAuthenticated('Authentication required');
    const tenantId = requireCurrentTenantId(
      'Missing active tenant context for Branch filesystem observation'
    );

    return runWithTenantDatabaseScope(this.db, tenantId, async () => {
      const branch = await this.branchRepo.findById(requestedBranchId);
      if (!branch) {
        throw new Forbidden('You do not have permission to observe this Branch filesystem');
      }
      let fsAccess: 'read' | 'write';
      try {
        fsAccess = await ensureBranchWorkspaceAccess(
          this.branchRepo,
          branch,
          userId,
          params.user?.role as UserRole | undefined,
          'view',
          'read',
          this.app.get('config').execution?.allow_superadmin === true
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Forbidden:')) {
          throw new Forbidden('You do not have permission to observe this Branch filesystem');
        }
        throw error;
      }
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        userId,
        this.app.get('config')
      );
      return {
        branchId: branch.branch_id,
        delegatedHomeKey,
        fsAccess,
        userId,
      };
    });
  }
}

export function createBranchFilesystemStatusService(
  branchRepo: BranchRepository,
  db: TenantScopeAwareDatabase,
  app: Application,
  dependencies?: Partial<BranchFilesystemStatusDependencies>
): BranchFilesystemStatusService {
  return new BranchFilesystemStatusService(branchRepo, db, app, dependencies);
}
