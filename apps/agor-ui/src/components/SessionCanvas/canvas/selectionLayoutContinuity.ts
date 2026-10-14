export interface SelectionLayoutContinuity {
  key: string;
  ids: string[];
  before: Record<string, { x: number; y: number }>;
  after: Record<string, { x: number; y: number }>;
}

export interface SelectionLayoutOrderItem {
  id: string;
  position: { x: number; y: number };
}

const positionMatches = (
  position: { x: number; y: number },
  expected?: { x: number; y: number }
): boolean =>
  expected !== undefined &&
  Math.abs(position.x - expected.x) <= 1 &&
  Math.abs(position.y - expected.y) <= 1;

/**
 * Preserve the user's initial spatial order while a just-persisted layout is
 * settling through controlled React Flow state and realtime echoes. A genuine
 * drag differs from both accepted snapshots and deliberately starts a new
 * spatial order.
 */
export function stableSelectionLayoutOrder(
  items: readonly SelectionLayoutOrderItem[],
  previous?: SelectionLayoutContinuity
): Pick<SelectionLayoutContinuity, 'key' | 'ids' | 'before'> {
  const key = items
    .map(({ id }) => id)
    .sort((leftId, rightId) => leftId.localeCompare(rightId))
    .join('\0');
  const canReuse =
    previous?.key === key &&
    items.every(
      ({ id, position }) =>
        positionMatches(position, previous.before[id]) ||
        positionMatches(position, previous.after[id])
    );
  const ids = canReuse
    ? previous.ids
    : [...items]
        .sort(
          (leftItem, rightItem) =>
            leftItem.position.y - rightItem.position.y ||
            leftItem.position.x - rightItem.position.x ||
            leftItem.id.localeCompare(rightItem.id)
        )
        .map(({ id }) => id);
  return {
    key,
    ids,
    before: Object.fromEntries(items.map(({ id, position }) => [id, position])),
  };
}
