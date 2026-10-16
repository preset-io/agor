type Position = { x: number; y: number };

/**
 * The positions a caller may save: only entities they can see that sit on this
 * board. Others are dropped rather than refused, so one entity moved or hidden
 * mid-switch doesn't fail the rest.
 */
export async function visibleBoardEntityPositions(
  boardId: string,
  positions: Readonly<Record<string, Position>>,
  findVisible: (objectId: string) => Promise<{ board_id: string } | null>
): Promise<Record<string, Position>> {
  const allowed: Record<string, Position> = {};
  for (const [objectId, position] of Object.entries(positions)) {
    const visible = await findVisible(objectId);
    if (visible?.board_id === boardId) allowed[objectId] = position;
  }
  return allowed;
}
