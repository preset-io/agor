import {
  CapabilityPolicyRepository,
  EntityNotFoundError,
  RepositoryError,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  BoardCapabilityPolicies,
  BoardID,
  BranchCapabilityPolicy,
  BranchID,
  CapabilityPolicyWorkspacePreferences,
  Params,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

export const CAPABILITY_POLICY_SERVICE_TRANSPORT_METHODS = ['find', 'patch'] as const;

function actor(params?: Params): { user_id: UserID; role?: string; service: boolean } | null {
  const user = (
    params as
      | { user?: { user_id?: string; role?: string; _isServiceAccount?: boolean } }
      | undefined
  )?.user;
  if (!user?.user_id) return null;
  return {
    user_id: user.user_id as UserID,
    role: user.role,
    service: user._isServiceAccount === true,
  };
}

function routeId(params?: Params): string {
  const id = (params as { route?: { id?: string } } | undefined)?.route?.id;
  if (!id) throw new BadRequest('Resource ID is required');
  return id;
}

function routeTenantId(params?: Params): string | undefined {
  return (params as { tenant?: { tenant_id?: string } } | undefined)?.tenant?.tenant_id;
}

function requireActor(params?: Params) {
  if (!params?.provider) return actor(params);
  const current = actor(params);
  if (!current) throw new NotAuthenticated('Authentication required');
  return current;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof Error && error.message.includes('reload before saving')) {
    throw new Conflict(error.message);
  }
  if (error instanceof EntityNotFoundError) throw new NotFound('Resource not found');
  if (error instanceof RepositoryError) throw new BadRequest(error.message);
  throw error;
}

export function setupCapabilityPolicyServices(
  app: import('@agor/core/feathers').Application,
  db: TenantScopeAwareDatabase,
  options: { allowSuperadmin?: boolean } = {}
): void {
  const repository = new CapabilityPolicyRepository(db);

  app.use(
    'boards/:id/permissions',
    {
      async find(params?: Params): Promise<BoardCapabilityPolicies> {
        const current = requireActor(params);
        const boardId = routeId(params) as BoardID;
        if (params?.provider && !current?.service && !hasMinimumRole(current?.role, ROLES.ADMIN)) {
          const access = await repository.resolveBoardAccess(boardId, current!.user_id);
          if (!access.capabilities.includes('board.view')) throw new Forbidden('Board not found');
        }
        return repository.getBoardPolicies(boardId);
      },
      async patch(_id: string | null, value: BoardCapabilityPolicies, params?: Params) {
        return runWithTenantDatabaseTransaction(db, routeTenantId(params), async (operationDb) => {
          const operationRepository = new CapabilityPolicyRepository(operationDb);
          await lockTenantAuthorizationFence(operationDb, params);
          const current = await resolveCurrentTenantAuthorityActor(operationDb, params, {
            allowActorlessTrusted: true,
          });
          const boardId = routeId(params) as BoardID;
          const existing = await operationRepository.getBoardPolicies(boardId);
          if (current && !current.service) {
            const access = await operationRepository.resolveBoardAccess(boardId, current!.user_id);
            const managesPolicy =
              hasMinimumRole(current?.role, ROLES.ADMIN) ||
              access.capabilities.includes('board.policy.manage');
            if (!managesPolicy) {
              throw new Forbidden('You cannot manage this board permission policy');
            }
            const preferences = await operationRepository.getWorkspacePreferences();
            if (
              value.branch_template.allow_shared_session_prompts &&
              !preferences.session_sharing_enabled
            ) {
              throw new Forbidden('Session sharing is disabled for this workspace');
            }
          }
          try {
            const saved = await operationRepository.replaceBoardPolicies(
              boardId,
              value,
              current?.user_id ?? existing.primary_owner_user_id
            );
            console.info(
              `[rbac.policy] updated kind=board board_id=${boardId} access_revision=${saved.board_access_revision} template_revision=${saved.branch_template_revision} access_entries=${saved.board_access.entries.length} template_entries=${saved.branch_template.access.entries.length}`
            );
            return saved;
          } catch (error) {
            mapRepositoryError(error);
          }
        });
      },
    },
    { methods: CAPABILITY_POLICY_SERVICE_TRANSPORT_METHODS }
  );

  app.use(
    'branches/:id/permissions',
    {
      async find(params?: Params): Promise<BranchCapabilityPolicy> {
        const current = requireActor(params);
        const branchId = routeId(params) as BranchID;
        if (
          params?.provider &&
          !current?.service &&
          !isSuperAdmin(current?.role, options.allowSuperadmin ?? true)
        ) {
          const access = await repository.resolveBranchAccess(branchId, current!.user_id);
          if (!access.capabilities.includes('branch.view')) throw new Forbidden('Branch not found');
        }
        return repository.getBranchPolicy(branchId);
      },
      async patch(_id: string | null, value: BranchCapabilityPolicy, params?: Params) {
        return runWithTenantDatabaseTransaction(db, routeTenantId(params), async (operationDb) => {
          const operationRepository = new CapabilityPolicyRepository(operationDb);
          await lockTenantAuthorizationFence(operationDb, params);
          const current = await resolveCurrentTenantAuthorityActor(operationDb, params, {
            allowActorlessTrusted: true,
          });
          const branchId = routeId(params) as BranchID;
          const existing = await operationRepository.getBranchPolicy(branchId);
          if (current && !current.service) {
            const access = await operationRepository.resolveBranchAccess(
              branchId,
              current!.user_id
            );
            const managesPolicy =
              isSuperAdmin(current?.role, options.allowSuperadmin ?? true) ||
              access.capabilities.includes('branch.policy.manage');
            const oldConfig =
              existing.binding_mode === 'inherit'
                ? existing.inherited_config
                : existing.override_config;
            const newConfig =
              value.binding_mode === 'inherit' ? value.inherited_config : value.override_config;
            if (!oldConfig || !newConfig)
              throw new BadRequest('A complete permission configuration is required');
            if (value.binding_mode === 'inherit') {
              const boardTemplate = existing.inherited_config;
              if (!boardTemplate || stable(newConfig) !== stable(boardTemplate)) {
                throw new BadRequest('Inherited permissions are read only');
              }
            }
            if (!managesPolicy) {
              throw new Forbidden('You cannot manage this branch permission policy');
            }
            const preferences = await operationRepository.getWorkspacePreferences();
            if (newConfig.allow_shared_session_prompts && !preferences.session_sharing_enabled) {
              throw new Forbidden('Session sharing is disabled for this workspace');
            }
          }
          try {
            const saved = await operationRepository.replaceBranchPolicy(
              branchId,
              value,
              current?.user_id ?? existing.primary_owner_user_id
            );
            const config =
              saved.binding_mode === 'inherit' ? saved.inherited_config : saved.override_config;
            console.info(
              `[rbac.policy] updated kind=branch branch_id=${branchId} binding=${saved.binding_mode} revision=${saved.revision} entries=${config?.access.entries.length ?? 0}`
            );
            return saved;
          } catch (error) {
            mapRepositoryError(error);
          }
        });
      },
    },
    { methods: CAPABILITY_POLICY_SERVICE_TRANSPORT_METHODS }
  );

  app.use(
    'workspace-preferences',
    {
      async find(params?: Params): Promise<CapabilityPolicyWorkspacePreferences> {
        requireActor(params);
        return repository.getWorkspacePreferences();
      },
      async patch(
        _id: string | null,
        value: CapabilityPolicyWorkspacePreferences,
        params?: Params
      ): Promise<CapabilityPolicyWorkspacePreferences> {
        return runWithTenantDatabaseTransaction(db, routeTenantId(params), async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, params);
          const current = await resolveCurrentTenantAuthorityActor(operationDb, params);
          if (!current.service && !hasMinimumRole(current.role, ROLES.ADMIN)) {
            throw new Forbidden('Only admins can manage workspace preferences');
          }
          const saved = await new CapabilityPolicyRepository(operationDb).setWorkspacePreferences(
            value,
            current.user_id
          );
          console.info(
            `[rbac.workspace_preferences] updated session_sharing_enabled=${saved.session_sharing_enabled}`
          );
          return saved;
        });
      },
    },
    { methods: CAPABILITY_POLICY_SERVICE_TRANSPORT_METHODS }
  );
}
