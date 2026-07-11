import {
  type BranchRepository,
  LinksRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { linkQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { HookContext, Link, Session, UserID } from '@agor/core/types';
import { isInternalLinkData, ROLES } from '@agor/core/types';
import { executorRuntimeScopeGuard } from '../auth/executor-runtime-scope.js';
import type { SessionsServiceImpl } from '../declarations.js';
import { requireMinimumRole } from '../utils/authorization.js';
import {
  cacheBranchAccess,
  isSuperAdmin,
  PERMISSION_RANK,
  resolveBranchPermission,
} from '../utils/branch-authorization.js';
import { injectCreatedBy } from '../utils/inject-created-by.js';

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

  const ensureLinkOwnerAccess = (mode: 'view' | 'mutate') => async (context: HookContext) => {
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

    if (!branchRbacEnabled || user._isServiceAccount) return context;

    const checkAccess = async (branchId: string | null | undefined, session: Session | null) => {
      if (!branchId) throw new Forbidden('Link owner branch not found');
      const branch = await branchRepository.findById(branchId);
      if (!branch) throw new Forbidden(`Branch not found: ${branchId}`);

      await cacheBranchAccess(context.params, branchRepository, branch);
      const isOwner = context.params.isBranchOwner ?? false;
      const effectiveLevel = resolveBranchPermission(
        branch,
        user.user_id as UserID,
        isOwner,
        user.role,
        superadminOpts.allowSuperadmin,
        context.params.branchPermission
      );

      if (mode === 'view') {
        if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.view) return;
        throw new Forbidden(
          `You need 'view' permission to view links. You have '${effectiveLevel}' permission.`
        );
      }

      const isSessionOwned = Boolean(session);
      const allowed = isSessionOwned
        ? PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt ||
          (effectiveLevel === 'session' && session?.created_by === user.user_id)
        : PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.all;

      if (!allowed) {
        throw new Forbidden(
          isSessionOwned
            ? `You need prompt permission (or session permission on your own session) to mutate session links. You have '${effectiveLevel}' permission.`
            : `You need 'all' permission to mutate branch links. You have '${effectiveLevel}' permission.`
        );
      }
    };

    if (context.method === 'create') {
      const records = Array.isArray(context.data) ? context.data : [context.data];
      for (const record of records as Partial<Link>[]) {
        let branchId: string | null | undefined = record.branch_id;
        let session: Session | null = null;
        if (record.session_id) {
          session = (await sessionsService.get(record.session_id, {
            provider: undefined,
          })) as Session;
          branchId = session.branch_id;
        }
        await checkAccess(branchId, session);
      }
      return context;
    }

    if (!link) return context;
    let branchId: string | null | undefined;
    let session: Session | null = null;
    if (link.session_id) {
      session = (await sessionsService.get(link.session_id, { provider: undefined })) as Session;
      branchId = session.branch_id;
    } else {
      branchId = link.branch_id;
    }
    await checkAccess(branchId, session);

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
      get: [ensureLinkOwnerAccess('view')],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create links'),
        ...externalMutationGuards,
        injectCreatedBy(),
        ensureLinkOwnerAccess('mutate'),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update links'),
        ...externalMutationGuards,
        rejectLinkOwnerPatch,
        ensureLinkOwnerAccess('mutate'),
      ],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete links'), ensureLinkOwnerAccess('mutate')],
    },
  };
}
