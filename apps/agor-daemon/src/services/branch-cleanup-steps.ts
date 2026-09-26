import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  BRANCH_WORKSPACE_REPORT_ACTIONS,
  type BranchID,
  type BranchMaintenanceClaim,
  branchCleanupCommandId,
  type UserRole,
  type UUID,
} from '@agor/core/types';
import { z } from 'zod';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

const schema = z
  .object({
    branch_id: z.string().uuid(),
    operation_id: z.string().uuid(),
    generation: z.number().int().positive(),
    execution_id: z.string().uuid(),
    action: z.enum(BRANCH_WORKSPACE_REPORT_ACTIONS),
  })
  .strict();

/** Identity-bound RPC; no command text, paths, output, or public status patches. */
export class BranchCleanupStepsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application
  ) {}
  async create(input: unknown, params?: AuthenticatedParams) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new BadRequest('Invalid workspace operation report');
    const data = parsed.data;
    const tenantId = requireCurrentTenantId();
    if (
      !params?.provider ||
      !params.user ||
      !matchesExecutorCommandRuntimeScope(
        params,
        branchCleanupCommandId(data.execution_id),
        data.branch_id
      ) ||
      params.tenant?.tenant_id !== tenantId ||
      params.authentication?.payload?.tenant_id !== tenantId
    )
      throw new Forbidden(
        'An executor credential for this exact workspace invocation and tenant is required'
      );
    const claim: BranchMaintenanceClaim = {
      kind: 'cleanup',
      branch_id: data.branch_id as BranchID,
      operation_id: data.operation_id as UUID,
      generation: data.generation,
    };
    const execution = data.execution_id as UUID;
    return runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      const maintenance = new BranchMaintenanceRepository(db);
      const cleanup = new BranchWorkspaceOperationRepository(db);
      if (data.action === 'claim') {
        await maintenance.claimExecution(claim, execution, async (tx) => {
          const repository = new BranchRepository(tx);
          const branch = await repository.findById(claim.branch_id);
          if (!branch || branch.workspace_operation?.requested_by !== params.user!.user_id)
            throw new Forbidden('Workspace operation actor changed');
          await ensureBranchWorkspaceAccess(
            repository,
            branch,
            params.user!.user_id,
            params.user!.role as UserRole,
            'all',
            'write',
            this.app.get('config').execution?.allow_superadmin === true
          );
          await cleanup.validateLaunch(tx, claim);
        });
        await cleanup.started(claim, execution);
      } else {
        // Exact invocation credentials and shared ownership fence completion even
        // if the actor's permissions were revoked after dispatch. This narrow
        // settlement acknowledgement grants no new filesystem access.
        await cleanup.finish(claim, execution, data.action);
      }
      const branch = await new BranchRepository(db).findById(claim.branch_id);
      if (branch)
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
