import { AmbiguousIdError, type BoardRepository, EntityNotFoundError } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, UUID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export type BoardRouteAccessMode = 'view' | 'mutate';

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
