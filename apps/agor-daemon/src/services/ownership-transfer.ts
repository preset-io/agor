import {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  EntityNotFoundError,
  enqueueAfterTenantDatabaseCommit,
  getCurrentTenantId,
  RepositoryError,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict, Forbidden } from '@agor/core/feathers';
import { isValidUUID } from '@agor/core/ids';
import type {
  BoardID,
  BranchID,
  OwnershipTransferRequest,
  OwnershipTransferResult,
  Params,
} from '@agor/core/types';
import { hasMinimumRole, OWNERSHIP_TRANSFER_SERVICES, ROLES } from '@agor/core/types';
import { LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT } from '../realtime/routing.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { formatStructuredLog, structuredLogErrorCode } from '../utils/structured-log.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

function validateRequest(value: unknown): asserts value is OwnershipTransferRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequest('An ownership transfer request is required');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !['expected_owner_user_id', 'target_user_id'].includes(key)) ||
    typeof data.expected_owner_user_id !== 'string' ||
    !isValidUUID(data.expected_owner_user_id) ||
    typeof data.target_user_id !== 'string' ||
    !isValidUUID(data.target_user_id)
  ) {
    throw new BadRequest(
      'Provide full expected_owner_user_id and target_user_id UUIDs only. Bulk, runtime and user lifecycle transfers are not supported.'
    );
  }
}

export function setupOwnershipTransferServices(
  app: Application,
  db: TenantScopeAwareDatabase
): void {
  for (const kind of ['board', 'branch'] as const) {
    app.use(
      OWNERSHIP_TRANSFER_SERVICES[kind],
      {
        async patch(
          id: string | null,
          value: unknown,
          params?: Params
        ): Promise<OwnershipTransferResult> {
          if (id !== null)
            throw new BadRequest('Use the resource ownership endpoint without an additional ID');
          validateRequest(value);
          const resourceId = (params as { route?: { id?: string } } | undefined)?.route?.id;
          if (!resourceId || !isValidUUID(resourceId))
            throw new BadRequest('A full resource UUID is required');
          const tenantId = (params as { tenant?: { tenant_id?: string } } | undefined)?.tenant
            ?.tenant_id;
          try {
            return await runWithTenantDatabaseTransaction(db, tenantId, async (operationDb) => {
              await lockTenantAuthorizationFence(operationDb, params);
              const actor = await resolveCurrentTenantAuthorityActor(operationDb, params);
              // No actorless or daemon-service-account transfer seam. Admin is a
              // deliberate tenant management right for BOTH resource types; branch
              // policy-management bypass configuration is not transfer authority.
              if (actor.service)
                throw new Forbidden('A workspace owner or administrator must transfer ownership');
              const policies = new CapabilityPolicyRepository(operationDb);
              const existing =
                kind === 'board'
                  ? await policies.getBoardPolicies(resourceId as BoardID)
                  : await policies.getBranchPolicy(resourceId as BranchID);
              if (
                actor.user_id !== existing.primary_owner_user_id &&
                !hasMinimumRole(actor.role, ROLES.ADMIN)
              ) {
                throw new Forbidden(
                  'Only the current primary owner or a workspace administrator can transfer ownership'
                );
              }
              if (value.expected_owner_user_id !== existing.primary_owner_user_id) {
                throw new Conflict('Primary owner changed; reload before transferring');
              }
              await policies.transferPrimaryOwner(kind, resourceId as BoardID | BranchID, value);
              const previousAccess =
                kind === 'board'
                  ? await policies.resolveBoardAccess(
                      resourceId as BoardID,
                      value.expected_owner_user_id
                    )
                  : await policies.resolveBranchAccess(
                      resourceId as BranchID,
                      value.expected_owner_user_id
                    );
              const resource =
                kind === 'board'
                  ? await new BoardRepository(operationDb).findById(resourceId)
                  : await new BranchRepository(operationDb).findById(resourceId);
              const effectiveTenantId = getCurrentTenantId();
              enqueueAfterTenantDatabaseCommit(() => {
                app.emit(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, {
                  tenantId: effectiveTenantId,
                });
                console.info(
                  formatStructuredLog('[rbac.ownership]', {
                    tenant_id: effectiveTenantId ?? 'default',
                    kind,
                    resource_id: resourceId,
                    actor_user_id: actor.user_id,
                    previous_owner_user_id: value.expected_owner_user_id,
                    primary_owner_user_id: value.target_user_id,
                  })
                );
              });
              emitServiceEvent(app, {
                path: kind === 'board' ? 'boards' : 'branches',
                event: 'patched',
                data: resource,
                id: resourceId,
                params,
              });
              return {
                scope: 'management_only',
                resource_type: kind,
                resource_id: resourceId as BoardID | BranchID,
                previous_owner_user_id: value.expected_owner_user_id,
                primary_owner_user_id: value.target_user_id,
                previous_owner_access: previousAccess,
              };
            });
          } catch (error) {
            // SQLite's immediate transaction may reject concurrent admission
            // rather than wait. No write committed: require a fresh read, just
            // as for a stale expected owner, instead of returning a raw DB error.
            if (structuredLogErrorCode(error).startsWith('SQLITE_BUSY')) {
              throw new Conflict('Another write is in progress; reload before transferring');
            }
            if (error instanceof EntityNotFoundError)
              throw new Forbidden('Resource is unavailable for ownership transfer');
            if (error instanceof RepositoryError) {
              if (error.message.includes('reload before saving')) throw new Conflict(error.message);
              throw new BadRequest(error.message);
            }
            throw error;
          }
        },
      },
      { methods: ['patch'] }
    );
  }
}
