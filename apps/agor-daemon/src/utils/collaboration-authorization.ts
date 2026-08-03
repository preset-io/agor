import { BoardRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { type AuthenticatedParams, type BoardID, ROLES, type UserID } from '@agor/core/types';

/**
 * Service-layer authorization boundary for resources owned by a board.
 *
 * Keeping this below transport hooks is intentional: REST, Socket.IO, MCP and
 * custom routes all call the same service methods. Tenant isolation remains
 * owned by the ambient tenant DB scope/RLS; this guard adds the narrower
 * current-user board decision inside that trusted tenant context.
 */
export class CollaborationAuthorization {
  private readonly boards: BoardRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly enabled: boolean,
    private readonly allowSuperadmin = true
  ) {
    this.boards = new BoardRepository(db);
  }

  async requireBoard(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    boardId: BoardID | string,
    mode: 'view' | 'mutate'
  ): Promise<void> {
    if (!this.enabled || !params?.provider) return;
    const user = params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount) return;
    if (user.role === ROLES.ADMIN || (this.allowSuperadmin && user.role === ROLES.SUPERADMIN))
      return;

    const allowed =
      mode === 'view'
        ? await this.boards.canView(boardId, user.user_id as UserID)
        : await this.boards.canMutate(boardId, user.user_id as UserID);
    if (!allowed) throw new Forbidden('Board resource not found or not accessible');
  }

  async canViewBoard(
    params: Pick<AuthenticatedParams, 'provider' | 'user'> | undefined,
    boardId: BoardID | string
  ): Promise<boolean> {
    try {
      await this.requireBoard(params, boardId, 'view');
      return true;
    } catch (error) {
      if (error instanceof Forbidden) return false;
      throw error;
    }
  }
}
