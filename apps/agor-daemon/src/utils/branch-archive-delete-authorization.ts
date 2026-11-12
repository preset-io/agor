import { type AgorConfig, branchMaintenanceCapabilities } from '@agor/core/config';
import type {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  RepoRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  BranchArchiveEligibility,
  BranchID,
  BranchMetadataAction,
  EffectiveBranchAccess,
  HookContext,
  UserID,
  UserRole,
} from '@agor/core/types';
import {
  getBranchCleanupBlockReason,
  getBranchMaintenanceBlockReason,
  hasMinimumRole,
  isBranchArchiveOrDeleteOptions,
  ROLES,
  resolveRepoCleanupPolicy,
} from '@agor/core/types';
import { isCallerBoardAdmin, isWorkspaceAdminOnBoard } from './board-route-authorization.js';
import {
  cacheBranchAccess,
  ensureBranchPermission,
  hasBranchPermission,
  isSuperAdmin,
} from './branch-authorization.js';

/**
 * Process-local capability proving the hooked archive/delete service boundary
 * completed its branch-control authorization. External callers cannot forge a
 * WeakSet membership through Feathers params or MCP input.
 */
const authorizedParams = new WeakMap<
  object,
  { branchId: BranchID; metadataAction: BranchMetadataAction }
>();

export function markBranchArchiveDeleteAuthorized(
  params: HookContext['params'],
  branchId: BranchID,
  metadataAction: BranchMetadataAction
): void {
  authorizedParams.set(params, { branchId, metadataAction });
}

export function consumeBranchArchiveDeleteAuthorization(
  params: HookContext['params'],
  branchId: BranchID,
  metadataAction: BranchMetadataAction
): void {
  const grant = authorizedParams.get(params);
  authorizedParams.delete(params);
  if (grant?.branchId !== branchId || grant.metadataAction !== metadataAction) {
    throw new Forbidden(
      'Branch archive/delete must be invoked through the authorized archive-or-delete service'
    );
  }
}

/**
 * Canonical branch-control gate for the long-running archive/delete service.
 * The caller supplies a tenant DB scope. This function resolves the canonical
 * branch ID, authorizes control, and grants the process-local capability before
 * any long-running side effect. Realtime visibility is intentionally captured
 * later, in the transaction that performs a hard delete.
 */
export async function authorizeBranchArchiveDelete(
  context: HookContext,
  options: {
    branchRepository: BranchRepository;
    superadminOpts?: { allowSuperadmin?: boolean };
    boardRepository: Pick<BoardRepository, 'canManage' | 'findById'>;
  }
): Promise<HookContext> {
  const id = context.params.route?.id;
  if (!id) throw new Error('Branch ID required');
  if (!isBranchArchiveOrDeleteOptions(context.data)) {
    throw new BadRequest('Invalid branch archive/delete options');
  }

  const branch = await options.branchRepository.findById(id);
  if (!branch) throw new Forbidden(`Branch not found: ${id}`);

  await cacheBranchAccess(context.params, options.branchRepository, branch);

  const { metadataAction, filesystemAction } = context.data;
  let authorized = false;
  if (metadataAction === 'archive' && branch.board_id) {
    // Metadata-only archive is granted to Board Managers (`board.policy.manage`),
    // Workspace Admins, and service accounts; destructive cleanup/removal on a board
    // branch still requires Workspace Admin, service account, or branch Manager+write.
    authorized =
      filesystemAction === 'preserved'
        ? await isCallerBoardAdmin(options.boardRepository, context.params.user, branch.board_id)
        : await isWorkspaceAdminOnBoard(
            options.boardRepository,
            context.params.user,
            branch.board_id
          );
  }

  if (!authorized) {
    ensureBranchPermission('all', 'archive or delete branches', options.superadminOpts)(context);
  }

  // Repository lookups accept short/uppercase prefixes but every trusted
  // boundary after this hook must use the canonical UUID. The route handler
  // reads this same params object after before hooks finish.
  context.params.route = { ...(context.params.route ?? {}), id: branch.branch_id };
  markBranchArchiveDeleteAuthorized(context.params, branch.branch_id, metadataAction);
  return context;
}

export async function resolveBranchArchiveEligibility(options: {
  branchRepository: Pick<BranchRepository, 'findById' | 'resolveUserAccess'>;
  boardRepository: Pick<BoardRepository, 'findById'>;
  capabilityPolicyRepository: Pick<CapabilityPolicyRepository, 'resolveBoardAccess'>;
  repoRepository: Pick<RepoRepository, 'findById'>;
  branchId: string;
  user: { user_id?: string; role?: string; _isServiceAccount?: boolean } | undefined;
  config?: AgorConfig;
  allowSuperadmin?: boolean;
}): Promise<BranchArchiveEligibility> {
  const { user } = options;
  if (!user) throw new NotAuthenticated('Authentication required');

  const branch = await options.branchRepository.findById(options.branchId);
  if (!branch) throw new Forbidden(`Branch not found: ${options.branchId}`);

  const isServiceAccount = Boolean(user._isServiceAccount);
  const userId = user.user_id as UserID | undefined;
  const userRole = user.role as UserRole | undefined;
  const allowSuperadmin =
    options.allowSuperadmin ?? options.config?.execution?.allow_superadmin === true;
  const isMemberOrAbove =
    isServiceAccount || (Boolean(userId) && hasMinimumRole(userRole, ROLES.MEMBER));
  const isWorkspaceAdmin =
    isServiceAccount || (Boolean(userId) && hasMinimumRole(userRole, ROLES.ADMIN));

  const branchAccess: EffectiveBranchAccess = isServiceAccount
    ? { can: 'all', fs_access: 'write', is_owner: false, source: 'superadmin' }
    : userId
      ? await options.branchRepository.resolveUserAccess(branch, userId)
      : { can: 'none', fs_access: 'none', is_owner: false, source: 'others' };

  const canViewBranch =
    isServiceAccount ||
    hasBranchPermission(
      branch,
      (userId ?? '') as UserID,
      branchAccess.is_owner,
      'view',
      userRole,
      allowSuperadmin,
      branchAccess.can
    );
  const hasBranchManager =
    isServiceAccount ||
    (isMemberOrAbove &&
      hasBranchPermission(
        branch,
        (userId ?? '') as UserID,
        branchAccess.is_owner,
        'all',
        userRole,
        allowSuperadmin,
        branchAccess.can
      ));
  const hasBranchWriteFs =
    isServiceAccount ||
    (hasBranchManager &&
      (branchAccess.is_owner ||
        isSuperAdmin(userRole, allowSuperadmin) ||
        branchAccess.fs_access === 'write'));

  const board = branch.board_id
    ? await options.boardRepository.findById(branch.board_id)
    : undefined;
  let canManageBoard = false;
  let canEditBoard = false;
  let canViewBoard = false;
  if (board) {
    if (isWorkspaceAdmin) {
      canManageBoard = true;
      canEditBoard = true;
      canViewBoard = true;
    } else if (userId && isMemberOrAbove) {
      const boardAccess = await options.capabilityPolicyRepository.resolveBoardAccess(
        board.board_id,
        userId
      );
      canViewBoard = boardAccess.capabilities.includes('board.view');
      canEditBoard = boardAccess.capabilities.includes('board.edit');
      canManageBoard = boardAccess.capabilities.includes('board.policy.manage');
    }
  }

  if (!isServiceAccount && !canViewBranch && !canManageBoard) {
    throw new Forbidden('You need view or board archive permission for this branch');
  }

  const repo = await options.repoRepository.findById(branch.repo_id);
  const cleanupPolicy = resolveRepoCleanupPolicy(repo?.cleanup_policy);
  const maintenanceCapabilities = options.config
    ? branchMaintenanceCapabilities(options.config, branch.storage_mode)
    : undefined;
  const cleanupProtected = branch.cleanup_protected ?? false;

  const canArchive = isServiceAccount || (isMemberOrAbove && (hasBranchManager || canManageBoard));
  const isBoardWorkspaceAdmin = Boolean(board && isWorkspaceAdmin);
  const canCleanupOnArchive =
    isServiceAccount || (isMemberOrAbove && (hasBranchWriteFs || isBoardWorkspaceAdmin));
  const canDelete = isServiceAccount || (isMemberOrAbove && hasBranchManager);
  const canDeleteFiles = isServiceAccount || (isMemberOrAbove && hasBranchWriteFs);
  const canRetireTeammate = isServiceAccount || (isMemberOrAbove && hasBranchManager);

  const cleanupBlocked =
    Boolean(getBranchCleanupBlockReason(cleanupPolicy, cleanupProtected)) ||
    Boolean(getBranchMaintenanceBlockReason(maintenanceCapabilities, 'archive_clean'));
  const defaultFilesystemAction = canCleanupOnArchive && !cleanupBlocked ? 'cleaned' : 'preserved';

  const boardVisible = Boolean(board && (canViewBoard || canManageBoard || isServiceAccount));
  const boardUnavailable = Boolean(branch.board_id && !boardVisible);

  return {
    branch_id: branch.branch_id,
    repo_id: branch.repo_id,
    board_id: branch.board_id ?? null,
    can_view_branch: canViewBranch,
    can_archive: canArchive,
    can_cleanup_on_archive: canCleanupOnArchive,
    can_delete: canDelete,
    can_delete_files: canDeleteFiles,
    can_retire_teammate: canRetireTeammate,
    can_clear_board_primary: canEditBoard,
    can_manage_board: canManageBoard,
    board_unavailable: boardUnavailable,
    branch_access: {
      can: branchAccess.can,
      fs_access: hasBranchWriteFs ? 'write' : (branchAccess.fs_access ?? 'none'),
      is_owner: branchAccess.is_owner,
      source: branchAccess.source,
    },
    default_filesystem_action: defaultFilesystemAction,
    cleanup_protected: cleanupProtected,
    maintenance_capabilities: maintenanceCapabilities,
    cleanup_policy: cleanupPolicy,
    ...(boardVisible && board
      ? {
          board: {
            board_id: board.board_id,
            name: board.name,
            url: board.url ?? null,
            primary_teammate_id: board.primary_teammate_id ?? null,
          },
        }
      : {}),
  };
}
