import { AmbiguousIdError, type BoardRepository, EntityNotFoundError } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, UUID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export type BoardRouteAccessMode = 'view' | 'mutate';

/**
 * Check whether the caller has tenant-scoped workspace ADMIN authority (or is
 * a service account) over a specific board. Workspace admins may operate on
 * any existing board inside their tenant without a per-board capability row,
 * whereas tenancy still requires the board to exist in the caller's tenant.
 */
export async function isWorkspaceAdminOnBoard(
  boardRepository: Pick<BoardRepository, 'findById'>,
  user: { user_id?: string; role?: string; _isServiceAccount?: boolean } | undefined,
  boardId: string | undefined
): Promise<boolean> {
  if (!user || !boardId) return false;
  if (!user._isServiceAccount && !hasMinimumRole(user.role, ROLES.ADMIN)) {
    return false;
  }
  // The bypass skips RBAC, not tenancy: a named board must resolve in caller's tenant scope.
  const board = await boardRepository.findById(boardId);
  return Boolean(board);
}

/**
 * Check whether a user has administrative authority over a specific board.
 *
 * Board administrators hold the 'board.policy.manage' capability on the board
 * (either as the board's primary owner, or via a Manager role grant on board_access),
 * or have the workspace ADMIN role (or service account) within their tenant scope.
 * Callers with role below MEMBER cannot administer boards.
 */
export async function isCallerBoardAdmin(
  boardRepository: Pick<BoardRepository, 'canManage' | 'findById'>,
  user: { user_id?: string; role?: string; _isServiceAccount?: boolean } | undefined,
  boardId: string | undefined
): Promise<boolean> {
  if (!user || !boardId) return false;
  if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) {
    return isWorkspaceAdminOnBoard(boardRepository, user, boardId);
  }
  if (!user.user_id || !hasMinimumRole(user.role, ROLES.MEMBER)) {
    return false;
  }
  try {
    return await boardRepository.canManage(boardId, user.user_id as UUID);
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      return false;
    }
    throw error;
  }
}

/**
 * Authorize an external caller against one board's current policy.
 *
 * Shared by board-content hooks and by non-transport service methods, which
 * Feathers never runs hooks for. Internal calls (no provider) pass; service
 * accounts and admins skip the policy check but the board must exist in their
 * tenant. Mutations also need the workspace Member role.
 * Missing, foreign-tenant, and inaccessible boards converge on the same
 * non-enumerating denial.
 */
export async function authorizeCallerBoard(
  boardRepository: Pick<BoardRepository, 'canView' | 'canMutate' | 'findById'>,
  params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
  boardId: string | undefined,
  mode: BoardRouteAccessMode,
  action: string
): Promise<void> {
  if (!params?.provider) return;
  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) {
    // The bypass skips RBAC, not tenancy: a named board must resolve in the caller's tenant scope.
    if (!boardId || (await boardRepository.findById(boardId).catch(() => null))) return;
    throw new Forbidden(`Board resource is unavailable to ${action}`);
  }
  // Mutations keep the hooks' workspace Member floor even when a board grants more.
  if (mode === 'mutate' && !hasMinimumRole(user.role, ROLES.MEMBER)) {
    throw new Forbidden(`You need member access to ${action}`);
  }
  let allowed = false;
  if (boardId) {
    try {
      allowed =
        mode === 'view'
          ? await boardRepository.canView(boardId, user.user_id as UUID)
          : await boardRepository.canMutate(boardId, user.user_id as UUID);
    } catch {
      // Same denial for missing, foreign-tenant, and inaccessible boards.
    }
  }
  if (!allowed) throw new Forbidden(`Board resource is unavailable to ${action}`);
}

/**
 * Resolve and authorize a nested board route without exposing hidden targets.
 *
 * Non-admin short IDs resolve inside the caller's live visibility predicate.
 * The resulting full ID replaces the route parameter before the service body
 * runs, preventing a second unscoped short-ID resolution from drifting from
 * the authorization decision.
 */
export function requireAuthorizedBoardRoute(
  boardRepository: BoardRepository,
  mode: BoardRouteAccessMode,
  action: string
) {
  return async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;

    const user = context.params.user;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');

    const requestedId = context.params.route?.id;
    if (!requestedId) throw new BadRequest('Board ID is required');

    const bypassAccess = user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN);
    let board = null;
    try {
      board = bypassAccess
        ? await boardRepository.findById(requestedId)
        : await boardRepository.findVisibleById(user.user_id as UUID, requestedId);
    } catch (error) {
      // Missing, hidden, and visibility-scoped short-ID failures deliberately
      // converge on the same authorization response below.
      if (!(error instanceof AmbiguousIdError)) throw error;
    }

    if (!board) {
      throw new Forbidden(`Board resource is unavailable to ${action}`);
    }

    let allowed = true;
    if (mode === 'mutate' && !bypassAccess) {
      try {
        allowed = await boardRepository.canMutate(board.board_id, user.user_id as UUID);
      } catch (error) {
        if (!(error instanceof EntityNotFoundError)) throw error;
        allowed = false;
      }
    }
    if (!allowed) {
      throw new Forbidden(`Board resource is unavailable to ${action}`);
    }

    context.params.route = { ...context.params.route, id: board.board_id };
    return context;
  };
}
