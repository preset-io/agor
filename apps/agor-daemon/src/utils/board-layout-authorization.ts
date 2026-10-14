import type { BoardObjectRepository, BoardRepository } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { BoardLayoutBatch, HookContext, UUID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

/** Every placement id a layout batch writes or asserts in its expected snapshot. */
export function boardLayoutPlacementIds(
  batch: Pick<BoardLayoutBatch, 'placements' | 'expected'>
): string[] {
  return [
    ...new Set([
      ...Object.keys(batch.placements ?? {}),
      ...Object.keys(batch.expected?.placements ?? {}),
    ]),
  ];
}

/**
 * `applyLayout` writes entity placements through the board row, so board
 * mutation (already enforced by the boards patch hook) is not enough: every
 * placement the batch writes or asserts must be one the caller could patch
 * through `board-objects`, where branch-bound rows require view on that
 * branch. Hidden, missing, and foreign-board ids share one non-enumerating
 * denial.
 */
export async function authorizeBoardLayoutPlacements(
  repositories: {
    boardRepository: Pick<BoardRepository, 'findBySlugOrId'>;
    boardObjectsRepository: Pick<BoardObjectRepository, 'findVisibleToUser'>;
  },
  context: HookContext,
  boardIdentifier: string | undefined,
  placementIds: readonly string[]
): Promise<void> {
  if (!context.params.provider || placementIds.length === 0) return;
  const user = context.params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return;
  const board = boardIdentifier
    ? await repositories.boardRepository.findBySlugOrId(boardIdentifier)
    : null;
  const visible = new Set(
    board
      ? (
          await repositories.boardObjectsRepository.findVisibleToUser(user.user_id as UUID, {
            board_id: board.board_id,
          })
        ).map((entity) => entity.object_id)
      : []
  );
  if (placementIds.some((objectId) => !visible.has(objectId))) {
    throw new Forbidden('Board resource is unavailable to update board objects');
  }
}
