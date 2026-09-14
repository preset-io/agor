import {
  and,
  BranchDeletionRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  deleteFrom,
  eq,
  or,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  select,
  sessions,
  sql,
  type TenantScopeAwareDatabase,
  uploads,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  BRANCH_DELETION_ACTIONS,
  BRANCH_DELETION_STAGES,
  type BranchID,
  type BranchMaintenanceClaim,
  branchDeletionCommandId,
  type SessionID,
  type TenantID,
  type UploadRef,
  type UserRole,
  type UUID,
} from '@agor/core/types';
import { z } from 'zod';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { captureBranchRemovalRealtimeVisibility } from '../utils/branch-removal-realtime.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { getUploadStagingStore } from '../utils/upload-staging.js';
import { issueExecutorCommandToken } from './session-token-service';

const reportSchema = z
  .object({
    branch_id: z.string().uuid(),
    operation_id: z.string().uuid(),
    generation: z.number().int().positive(),
    execution_id: z.string().uuid(),
    action: z.enum(BRANCH_DELETION_ACTIONS),
    // This is a controlled stage summary, never a raw exception, path or token.
    stage: z.enum(BRANCH_DELETION_STAGES).optional(),
  })
  .strict();

/** Short independently authenticated DB steps; no replica-local response reservation. */
export class BranchDeletionStepsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application
  ) {}

  async create(input: unknown, params?: AuthenticatedParams) {
    const parsed = reportSchema.safeParse(input);
    if (!parsed.success) throw new BadRequest('Invalid deletion step');
    const data = parsed.data;
    if (
      !params?.provider ||
      !params.user ||
      !matchesExecutorCommandRuntimeScope(
        params,
        branchDeletionCommandId(data.execution_id),
        data.branch_id
      )
    ) {
      throw new Forbidden('An executor credential for this exact deletion invocation is required');
    }
    const tenantId = requireCurrentTenantId();
    if (
      params.tenant?.tenant_id !== tenantId ||
      params.authentication?.payload?.tenant_id !== tenantId
    )
      throw new Forbidden('Deletion tenant scope does not match');
    const claim: BranchMaintenanceClaim = {
      branch_id: data.branch_id as BranchID,
      operation_id: data.operation_id as UUID,
      generation: data.generation,
      kind: 'delete',
    };
    const execution = data.execution_id as UUID;
    // Keep all DB access in explicit tenant units, including authorization. The
    // upload adapter below does external I/O BETWEEN units, never under a lock.
    await runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      const repository = new BranchRepository(db);
      const branch = await repository.findById(claim.branch_id);
      if (!branch) throw new BadRequest('Branch deletion no longer exists');
      await ensureBranchWorkspaceAccess(
        repository,
        branch,
        params.user!.user_id,
        params.user!.role as UserRole,
        'all',
        'write',
        this.app.get('config').execution?.allow_superadmin === true
      );
    });
    if (data.action === 'upload') {
      const upload = await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
        new BranchMaintenanceRepository(db).withExecution(claim, execution, async (tx) => {
          const row = await select(tx)
            .from(uploads)
            .where(
              or(
                eq(uploads.branch_id, claim.branch_id),
                sql`${uploads.session_id} IN (SELECT session_id FROM sessions WHERE branch_id = ${claim.branch_id})`
              )
            )
            .orderBy(uploads.upload_ref)
            .limit(1)
            .one();
          if (!row) return undefined;
          const session = await select(tx)
            .from(sessions)
            .where(eq(sessions.session_id, row.session_id))
            .one();
          if (
            row.branch_id !== claim.branch_id ||
            (session && session.branch_id !== claim.branch_id) ||
            row.storage_key !== row.upload_ref
          )
            throw new BadRequest('Upload ownership requires reconciliation');
          return row;
        })
      );
      if (!upload) return { remaining: false };
      await getUploadStagingStore().delete({
        tenantId: tenantId as TenantID,
        branchId: claim.branch_id,
        sessionId: upload.session_id as SessionID,
        ref: upload.upload_ref as UploadRef,
      });
      await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
        new BranchMaintenanceRepository(db).withExecution(claim, execution, async (tx) => {
          await deleteFrom(tx, uploads)
            .where(
              and(eq(uploads.upload_ref, upload.upload_ref), eq(uploads.branch_id, claim.branch_id))
            )
            .run();
        })
      );
      return { remaining: true };
    }
    return runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      const maintenance = new BranchMaintenanceRepository(db);
      const deletion = new BranchDeletionRepository(db);
      if (data.action === 'claim') await maintenance.claimExecution(claim, execution);
      else if (data.action === 'heartbeat') {
        await maintenance.heartbeatExecution(claim, execution);
        const expiresAt = params.authentication?.payload?.exp;
        if (typeof expiresAt === 'number' && expiresAt * 1000 - Date.now() < 5 * 60_000) {
          const sessionToken = await maintenance.withExecution(claim, execution, async (tx) => {
            const repository = new BranchRepository(tx);
            const branch = await repository.findById(claim.branch_id);
            if (!branch) throw new BadRequest('Branch deletion no longer exists');
            await ensureBranchWorkspaceAccess(
              repository,
              branch,
              params.user!.user_id,
              params.user!.role as UserRole,
              'all',
              'write',
              this.app.get('config').execution?.allow_superadmin === true
            );
            return issueExecutorCommandToken(
              this.app,
              branchDeletionCommandId(execution),
              params.user!.user_id,
              claim.branch_id
            );
          });
          return { ok: true, sessionToken };
        }
      } else if (data.action === 'quiesce') return deletion.quiescePage(claim, execution);
      else if (data.action === 'storage') await deletion.verifyStorage(claim, execution);
      else if (data.action === 'data') return deletion.deleteDataPage(claim, execution);
      else if (data.action === 'finalize') {
        const branch = await new BranchRepository(db).findById(claim.branch_id);
        await deletion.finalize(claim, execution, async (tx) => {
          await captureBranchRemovalRealtimeVisibility({
            params,
            branchRepository: new BranchRepository(tx),
            branchId: claim.branch_id,
          });
          emitServiceEvent(this.app, {
            path: 'branches',
            event: 'removed',
            data: branch!,
            params,
            id: claim.branch_id,
          });
        });
        return { deleted: true };
      } else if (data.action === 'failed') {
        // The worker reports only AFTER all its awaited storage work settles.
        // Unknown/lost reports cannot get here and retain their invocation.
        await deletion.failSettled(
          claim,
          execution,
          `Permanent deletion failed during ${data.stage ?? 'storage'}. Inspect executor logs and retry deletion.`
        );
      }
      const branch = await new BranchRepository(db).findById(claim.branch_id);
      if (branch && data.action !== 'heartbeat')
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'patched',
          data: branch,
          params,
          id: claim.branch_id,
        });
      return { ok: true };
    });
  }
}
