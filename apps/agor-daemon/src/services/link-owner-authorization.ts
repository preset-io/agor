import type { BranchRepository } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, LinkOwner, Session, UUID } from '@agor/core/types';
import {
  isSuperAdmin,
  PERMISSION_RANK,
  resolveBranchPermission,
} from '../utils/branch-authorization.js';

export const LINK_OWNER_ACCESS_MODE = {
  view: 'view',
  mutate: 'mutate',
} as const;

export type LinkOwnerAccessMode =
  (typeof LINK_OWNER_ACCESS_MODE)[keyof typeof LINK_OWNER_ACCESS_MODE];

interface LinkOwnerSessionsService {
  get(id: string, params?: AuthenticatedParams): Promise<Session>;
}

export interface LinkOwnerAuthorizationOptions {
  branchRepository: BranchRepository;
  branchRbacEnabled: boolean;
  sessionsService?: LinkOwnerSessionsService;
  superadminOpts: { allowSuperadmin: boolean };
}

const LINK_OWNER_ACCESS_COPY = {
  authenticationRequired: 'Authentication required',
  branchMissing: 'Link owner branch not found',
  view: (level: string) =>
    `You need 'view' permission to view links. You have '${level}' permission.`,
  mutateSession: (level: string) =>
    `You need prompt permission (or session permission on your own session) to mutate session links. You have '${level}' permission.`,
  mutateBranch: (level: string) =>
    `You need 'all' permission to mutate branch links. You have '${level}' permission.`,
} as const;

async function resolveOwnerContext(
  owner: LinkOwner,
  options: LinkOwnerAuthorizationOptions
): Promise<{ branchId: BranchID; session: Session | null }> {
  if (owner.session_id) {
    if (!options.sessionsService) throw new Forbidden(LINK_OWNER_ACCESS_COPY.branchMissing);
    const session = await options.sessionsService.get(owner.session_id, { provider: undefined });
    return { branchId: session.branch_id, session };
  }
  if (!owner.branch_id) throw new Forbidden(LINK_OWNER_ACCESS_COPY.branchMissing);
  return { branchId: owner.branch_id, session: null };
}

export async function ensureLinkOwnerAccess(args: {
  mode: LinkOwnerAccessMode;
  owner: LinkOwner;
  options: LinkOwnerAuthorizationOptions;
  params?: AuthenticatedParams;
}): Promise<void> {
  if (!args.params?.provider) return;
  const user = args.params.user;
  if (!user) throw new NotAuthenticated(LINK_OWNER_ACCESS_COPY.authenticationRequired);
  if (!args.options.branchRbacEnabled || user._isServiceAccount) return;
  if (isSuperAdmin(user.role, args.options.superadminOpts.allowSuperadmin)) return;

  const { branchId, session } = await resolveOwnerContext(args.owner, args.options);
  const branch = await args.options.branchRepository.findById(branchId);
  if (!branch) throw new Forbidden(`Branch not found: ${branchId}`);

  const userId = user.user_id as UUID;
  const [isOwner, branchPermission] = await Promise.all([
    args.options.branchRepository.isOwner(branch.branch_id, userId),
    args.options.branchRepository.resolveUserPermission(branch, userId),
  ]);
  const effectiveLevel = resolveBranchPermission(
    branch,
    userId,
    isOwner,
    user.role,
    args.options.superadminOpts.allowSuperadmin,
    branchPermission
  );

  if (args.mode === LINK_OWNER_ACCESS_MODE.view) {
    if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.view) return;
    throw new Forbidden(LINK_OWNER_ACCESS_COPY.view(effectiveLevel));
  }

  const allowed = session
    ? PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt ||
      (effectiveLevel === 'session' && session.created_by === user.user_id)
    : PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.all;
  if (allowed) return;
  throw new Forbidden(
    session
      ? LINK_OWNER_ACCESS_COPY.mutateSession(effectiveLevel)
      : LINK_OWNER_ACCESS_COPY.mutateBranch(effectiveLevel)
  );
}
