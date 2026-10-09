import {
  BranchRepository,
  BranchWorkspaceOperationRepository,
  EntityNotFoundError,
  getCurrentTenantId,
  RepositoryError,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type { AuthenticatedParams, Branch, UUID } from '@agor/core/types';
import { z } from 'zod';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence';

const requestSchema = z.object({ operation_id: z.string().uuid() }).strict();

/** Notification acknowledgement is metadata-only, not a maintenance transition. */
export class BranchWorkspaceNotificationService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async create(data: unknown, params: AuthenticatedParams): Promise<Branch> {
    if (!params.user) throw new NotAuthenticated('Authentication required');
    const input = requestSchema.safeParse(data);
    const branchId = params.route?.id;
    if (!input.success || typeof branchId !== 'string')
      throw new BadRequest('A branch route ID and workspace operation_id are required');
    try {
      return await runWithTenantDatabaseTransaction(
        this.db,
        params.tenant?.tenant_id ?? getCurrentTenantId(),
        async (db) => {
          await lockTenantAuthorizationFence(db, params);
          const actor = await resolveCurrentTenantAuthorityActor(db, params);
          // Resolve short IDs at the API boundary; the storage lock always
          // targets the canonical Branch row.
          const branch = await new BranchRepository(db).findById(branchId);
          if (!branch) throw new NotFound('Branch not found');
          return new BranchWorkspaceOperationRepository(db).dismissNotification(
            branch.branch_id,
            input.data.operation_id as UUID,
            async (tx, branch) => {
              const access = await new BranchRepository(tx).resolveUserAccess(
                branch,
                actor.user_id
              );
              if (!access.is_owner && access.can !== 'all')
                throw new Forbidden(
                  'Branch Manager access is required to dismiss notifications for everyone'
                );
            }
          );
        }
      );
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw new NotFound('Branch not found');
      if (error instanceof RepositoryError) throw new Conflict(error.message);
      throw error;
    }
  }
}
