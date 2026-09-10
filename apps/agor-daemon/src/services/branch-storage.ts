import { analyticsLogger } from '@agor/core/analytics';
import type { AgorConfig } from '@agor/core/config';
import {
  assertTenantWritable,
  BranchRepository,
  BranchStorageRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  type BranchBundleReceipt,
  type BranchID,
  type BranchStorageExecutorAction,
  type BranchStorageRecord,
  branchStorageExecutorCommandId,
  type UserID,
} from '@agor/core/types';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import { resolveBranchExecutorSandboxMounts } from '../utils/branch-executor-sandbox.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { getBranchBundleStore } from '../utils/upload-staging.js';
import { issueExecutorCommandToken } from './session-token-service.js';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';
import type { TerminalsService } from './terminals.js';

class WorkspaceExecutorFailure extends Error {
  constructor(
    message: string,
    readonly settled: boolean
  ) {
    super(message);
  }
}

export class BranchStorageService {
  private readonly restoring = new Map<string, Promise<void>>();
  constructor(
    private readonly app: Application,
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: AgorConfig,
    private readonly terminals: TerminalsService | null
  ) {}

  private scope<T>(
    params: AuthenticatedParams,
    work: (db: TenantScopedDatabase) => Promise<T>
  ): Promise<T> {
    const tenantId = params.tenant?.tenant_id;
    if (!tenantId || !params.user?.user_id) throw new NotAuthenticated('Authentication required');
    return runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      return work(db);
    });
  }

  private async authorize(id: BranchID, params: AuthenticatedParams) {
    return this.scope(params, async (db) => {
      const repo = new BranchRepository(db);
      const branch = await repo.findById(id);
      if (!branch) throw new NotFound('Branch not found');
      const userId = params.user!.user_id as UserID;
      const access = await repo.resolveUserAccess(branch, userId);
      // Branch prompting capability, without a superadmin prompt bypass.
      // This fixed maintenance command can write the restored snapshot; it
      // does not grant the caller file content or an arbitrary writable shell.
      if (
        !hasBranchPermission(
          branch,
          userId,
          access.is_owner,
          'session',
          undefined,
          false,
          access.can
        )
      )
        throw new Forbidden('Branch prompting permission required for workspace storage');
      return branch;
    });
  }

  async create(id: BranchID, action: unknown, params: AuthenticatedParams): Promise<unknown> {
    const branch = await this.authorize(id, params);
    if (action === 'restore') {
      await this.restore(branch.branch_id, params);
    } else if (action === 'cool') {
      if (this.config.execution?.branch_storage?.cold_storage_enabled !== true)
        throw new Forbidden('Moving workspaces to cold storage is disabled');
      getBranchBundleStore(); // Fail before closing admission if durable storage is absent.
      if (this.terminals?.hasBranchActivity(params.tenant!.tenant_id, branch.branch_id)) {
        throw new Conflict(
          'Close terminal attachments and quit their shells before moving this branch to cold storage'
        );
      }
      let record = await this.admit(branch.branch_id, params, (db) =>
        new BranchStorageRepository(db).beginCooling(branch.branch_id)
      );
      this.track('requested', 'cool', branch.branch_id, record, params);
      await this.emit(branch.branch_id, params);
      try {
        const packed = (await this.execute(branch.branch_id, record, 'pack', params)) as {
          receipt: BranchBundleReceipt;
        };
        record = await this.scope(params, (db) =>
          new BranchStorageRepository(db).saveReceipt(
            branch.branch_id,
            record.operationId!,
            packed.receipt
          )
        );
        await this.emit(branch.branch_id, params);
        await this.execute(branch.branch_id, record, 'cleanup', params);
        await this.scope(params, (db) =>
          new BranchStorageRepository(db).finishCooling(branch.branch_id, record.operationId!)
        );
        this.track('succeeded', 'cool', branch.branch_id, record, params);
      } catch (error) {
        this.track('failed', 'cool', branch.branch_id, record, params);
        await this.scope(params, (db) =>
          new BranchStorageRepository(db).fail(
            branch.branch_id,
            record.operationId!,
            record.phase!,
            'Moving the workspace to cold storage failed; inspect the operation before retrying',
            error instanceof WorkspaceExecutorFailure && error.settled
          )
        );
        throw error;
      } finally {
        await this.emit(branch.branch_id, params);
      }
    } else throw new BadRequest('Expected cool or restore');
    return this.scope(params, (db) => new BranchRepository(db).findById(branch.branch_id));
  }

  /** Concurrent local prompts join; the durable branch transition arbitrates other daemons. */
  async restore(id: BranchID, params: AuthenticatedParams, queuedAt?: string): Promise<void> {
    await this.authorize(id, params);
    const key = `${params.tenant!.tenant_id}:${id}`;
    const running = this.restoring.get(key);
    if (running) {
      await running;
      this.trackQueueWait(id, params, queuedAt);
      return;
    }
    const work = this.performRestore(id, params);
    this.restoring.set(key, work);
    try {
      await work;
      this.trackQueueWait(id, params, queuedAt);
    } finally {
      if (this.restoring.get(key) === work) this.restoring.delete(key);
    }
  }

  private async performRestore(id: BranchID, params: AuthenticatedParams): Promise<void> {
    const previous = await this.scope(params, (db) => new BranchStorageRepository(db).get(id));
    if (previous.residency === 'warm') return;
    if (previous.residency === 'warming' && !previous.retryable)
      throw new Conflict(
        'Workspace is already restoring. If interrupted, executor confirmation is required before recovery'
      );
    if (previous.residency === 'cooling' && !previous.retryable)
      throw new Conflict('Workspace is moving to cold storage; retry shortly');
    getBranchBundleStore();
    let record = await this.admit(id, params, (db) =>
      new BranchStorageRepository(db).beginRestore(id)
    );
    this.track('requested', 'restore', id, record, params);
    await this.emit(id, params);
    try {
      await this.execute(id, record, 'restore', params);
      record = await this.scope(params, (db) =>
        new BranchStorageRepository(db).markPublishing(id, record.operationId!)
      );
      await this.emit(id, params);
      await this.execute(id, record, 'publish', params);
      await this.scope(params, (db) =>
        new BranchStorageRepository(db).finishRestore(id, record.operationId!)
      );
      this.track('succeeded', 'restore', id, record, params);
    } catch (error) {
      this.track('failed', 'restore', id, record, params);
      await this.scope(params, (db) =>
        new BranchStorageRepository(db).fail(
          id,
          record.operationId!,
          record.phase!,
          'Workspace restore failed; the retained bundle is still available',
          error instanceof WorkspaceExecutorFailure && error.settled
        )
      );
      throw error;
    } finally {
      await this.emit(id, params);
    }
  }

  private async admit<T>(
    id: BranchID,
    params: AuthenticatedParams,
    work: (db: TenantScopedDatabase) => Promise<T>
  ): Promise<T> {
    return runWithTenantDatabaseTransaction(this.db, params.tenant!.tenant_id, async (db) => {
      await lockTenantAuthorizationFence(db, params);
      await this.authorize(id, params);
      return work(db);
    });
  }

  private async execute(
    id: BranchID,
    record: BranchStorageRecord,
    action: BranchStorageExecutorAction,
    params: AuthenticatedParams
  ): Promise<unknown> {
    const projection = await this.scope(params, async (db) => {
      const branch = await new BranchRepository(db).findById(id);
      if (!branch) throw new NotFound('Branch not found');
      const userId = params.user!.user_id as UserID;
      return {
        branch,
        userId,
        token: await issueExecutorCommandToken(
          this.app,
          branchStorageExecutorCommandId(record.operationId!, action),
          userId,
          id
        ),
        home: await resolveDelegatedExecutionHomeKey(this.db, userId, this.config),
        mounts: await resolveBranchExecutorSandboxMounts({
          config: this.config,
          db: this.db,
          branch,
          tenantId: params.tenant!.tenant_id,
          executionUserId: userId,
        }),
      };
    });
    const result = await requestExecutor(
      {
        command: 'branch.storage',
        sessionToken: projection.token,
        daemonUrl: getDaemonUrl(),
        params: {
          branchId: id,
          operationId: record.operationId,
          action,
          cwd: projection.branch.path,
          principalBranchAccess: 'write',
          replacePartial: record.replacePartial,
          ...projection.mounts,
          digest: record.receipt
            ? { sha256: record.receipt.sha256, bytes: record.receipt.bytes }
            : undefined,
        },
      },
      {
        timeoutMs: 60 * 60 * 1000,
        delegatedHomeKey: projection.home,
        templateVariables: { branch_id: id, user_id: projection.userId, branch_fs_access: 'write' },
      }
    );
    if (!result.success)
      throw new WorkspaceExecutorFailure(
        result.error?.message ?? 'Workspace executor failed',
        result.error?.code === 'BRANCH_STORAGE_FAILED'
      );
    return result.data;
  }

  private trackQueueWait(id: BranchID, params: AuthenticatedParams, queuedAt?: string): void {
    if (!queuedAt || !Number.isFinite(Date.parse(queuedAt))) return;
    runWithTenantContext(params.tenant!.tenant_id, () =>
      analyticsLogger.track(
        'branch.storage.queue_wait',
        {
          branch_id: id,
          duration_ms: Math.max(0, Date.now() - Date.parse(queuedAt)),
        },
        { userId: params.user!.user_id }
      )
    );
  }

  private async emit(id: BranchID, params: AuthenticatedParams): Promise<void> {
    const branch = await this.scope(params, (db) => new BranchRepository(db).findById(id));
    if (branch)
      emitServiceEvent(this.app, { path: 'branches', event: 'patched', data: branch, params, id });
  }

  private track(
    outcome: 'requested' | 'succeeded' | 'failed',
    action: 'cool' | 'restore',
    id: BranchID,
    record: BranchStorageRecord,
    params: AuthenticatedParams
  ): void {
    runWithTenantContext(params.tenant!.tenant_id, () =>
      analyticsLogger.track(
        `branch.storage.${outcome}`,
        {
          branch_id: id,
          action,
          phase: record.phase,
          duration_ms: record.startedAt
            ? Math.max(0, Date.now() - Date.parse(record.startedAt))
            : 0,
          bytes: record.receipt?.bytes,
        },
        { userId: params.user!.user_id }
      )
    );
  }
}
