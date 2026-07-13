import {
  type BranchRepository,
  LinksRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { linkQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { HookContext, Link, LinkOwner, UserID } from '@agor/core/types';
import { isInternalLinkData, ROLES } from '@agor/core/types';
import { executorRuntimeScopeGuard } from '../auth/executor-runtime-scope.js';
import type { SessionsServiceImpl } from '../declarations.js';
import { requireMinimumRole } from '../utils/authorization.js';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { injectCreatedBy } from '../utils/inject-created-by.js';
import {
  ensureLinkOwnerAccess as authorizeLinkOwnerAccess,
  LINK_OWNER_ACCESS_MODE,
  type LinkOwnerAccessMode,
} from './link-owner-authorization.js';

export function isExternalFileBackedLinkMutation(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    (typeof record.file_path === 'string' && record.file_path.length > 0) ||
    record.source === 'upload' ||
    record.kind === 'image' ||
    record.kind === 'document'
  );
}

export function isExternalInternalLinkMutation(data: unknown): boolean {
  if (isInternalLinkData(data)) return true;
  return (
    data != null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    ('target_object_type' in data || 'target_object_id' in data)
  );
}

export function getExternalLinkProvenanceMutationError(
  data: unknown,
  method: 'create' | 'patch'
): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if ('source_message_id' in record) {
    return "Link field 'source_message_id' is server-managed";
  }
  if (method === 'patch' && 'source' in record) {
    return "Link field 'source' is immutable";
  }
  if (method === 'create' && record.source !== 'manual') {
    return "External links must use source 'manual'";
  }
  return null;
}

interface LinksHooksContext {
  db: TenantScopeAwareDatabase;
  branchRepository: BranchRepository;
  branchRbacEnabled: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  sessionsService: SessionsServiceImpl;
  superadminOpts: { allowSuperadmin: boolean };
}

type ExternalMutationError = (
  record: Record<string, unknown>,
  context: HookContext
) => string | null;

function rejectExternalMutation(getError: ExternalMutationError) {
  return (context: HookContext) => {
    if (!context.params.provider) return context;
    const records = Array.isArray(context.data) ? context.data : [context.data];
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const error = getError(record as Record<string, unknown>, context);
      if (error) throw new Forbidden(error);
    }
    return context;
  };
}

export function linksHooks({
  db,
  branchRepository,
  branchRbacEnabled,
  requireAuth,
  sessionsService,
  superadminOpts,
}: LinksHooksContext) {
  const linksRepository = new LinksRepository(db);
  const ownerAuthorizationOptions = {
    branchRepository,
    branchRbacEnabled,
    sessionsService,
    superadminOpts,
  };

  const hideExternalInternalLinks = (context: HookContext) => {
    if (context.params.provider) {
      (context.params as { _agorHideInternalLinks?: boolean })._agorHideInternalLinks = true;
    }
    return context;
  };

  const scopeFindToAccessibleLinksSql = (context: HookContext) => {
    if (!branchRbacEnabled || !context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;
    const user = context.params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (isSuperAdmin(user.role, superadminOpts.allowSuperadmin)) return context;
    (context.params as { _agorSqlLinkAccessUserId?: UserID })._agorSqlLinkAccessUserId =
      user.user_id as UserID;
    return context;
  };

  const ensureLinkOwnerAccess = (mode: LinkOwnerAccessMode) => async (context: HookContext) => {
    if (!context.params.provider) return context;

    const user = context.params.user;
    if (!user) throw new NotAuthenticated('Authentication required');

    let link: Link | null = null;
    if (context.method !== 'create' && context.id) {
      link = await linksRepository.findById(String(context.id));
      if (!link || isInternalLinkData(link)) throw new NotFound(`Link not found: ${context.id}`);
      (context.params as { _agorPrefetchedRecord?: unknown })._agorPrefetchedRecord = {
        id: String(context.id),
        idField: 'link_id',
        record: link,
      };
    }

    if (context.method === 'create') {
      const records = Array.isArray(context.data) ? context.data : [context.data];
      for (const record of records as Partial<Link>[]) {
        await authorizeLinkOwnerAccess({
          mode,
          owner: record as LinkOwner,
          options: ownerAuthorizationOptions,
          params: context.params,
        });
      }
      return context;
    }

    if (!link) return context;
    await authorizeLinkOwnerAccess({
      mode,
      owner: link as LinkOwner,
      options: ownerAuthorizationOptions,
      params: context.params,
    });

    return context;
  };

  const rejectLinkOwnerPatch = (context: HookContext) => {
    const data = context.data as Record<string, unknown> | undefined;
    if (!data) return context;
    for (const key of [
      'link_id',
      'branch_id',
      'session_id',
      'created_by',
      'created_at',
      'updated_at',
    ]) {
      if (key in data) throw new Forbidden(`Link field '${key}' is immutable`);
    }
    return context;
  };

  const rejectLinkDerivedFields = rejectExternalMutation((record) =>
    'target_key' in record ? "Link field 'target_key' is server-derived" : null
  );
  const rejectExternalFileBackedLinkMutations = rejectExternalMutation((record) =>
    isExternalFileBackedLinkMutation(record)
      ? 'File-backed links must be created through the upload endpoint'
      : null
  );
  const rejectExternalInternalLinkMutations = rejectExternalMutation((record) =>
    isExternalInternalLinkMutation(record)
      ? 'Internal links require target authorization and are not externally available'
      : null
  );
  const rejectExternalLinkProvenanceMutations = rejectExternalMutation((record, context) =>
    getExternalLinkProvenanceMutationError(record, context.method === 'patch' ? 'patch' : 'create')
  );
  const externalMutationGuards = [
    rejectLinkDerivedFields,
    rejectExternalLinkProvenanceMutations,
    rejectExternalFileBackedLinkMutations,
    rejectExternalInternalLinkMutations,
  ];

  return {
    before: {
      all: [typedValidateQuery(linkQueryValidator), requireAuth, executorRuntimeScopeGuard()],
      find: [hideExternalInternalLinks, scopeFindToAccessibleLinksSql],
      get: [ensureLinkOwnerAccess(LINK_OWNER_ACCESS_MODE.view)],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create links'),
        ...externalMutationGuards,
        injectCreatedBy(),
        ensureLinkOwnerAccess(LINK_OWNER_ACCESS_MODE.mutate),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update links'),
        ...externalMutationGuards,
        rejectLinkOwnerPatch,
        ensureLinkOwnerAccess(LINK_OWNER_ACCESS_MODE.mutate),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete links'),
        ensureLinkOwnerAccess(LINK_OWNER_ACCESS_MODE.mutate),
      ],
    },
  };
}
