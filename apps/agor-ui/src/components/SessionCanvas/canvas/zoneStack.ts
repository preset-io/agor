import {
  BOARD_GRID_SIZE,
  ceilBoardGridValue,
  type RectanglePlacement,
} from '@agor/core/layout/rectangle-packing';
import type { Node } from 'reactflow';

export const ZONE_STACK_HEADER_SELECTOR = '[data-zone-stack-header]';

export interface ZoneStackPresentation {
  zoneId: string;
  stackIndex: number;
  deckDepth: number;
  revealHeight: number;
}

/**
 * The next shingle starts after the tallest rendered header. Rounding upward
 * is intentional: rounding down to the board grid would clip the last pixels
 * of a title or icon row.
 */
export function zoneStackRevealHeight(headerHeights: readonly number[]): number {
  const tallest = headerHeights.reduce(
    (maximum, height) =>
      Number.isFinite(height) && height > 0 ? Math.max(maximum, height) : maximum,
    0
  );
  return Math.max(BOARD_GRID_SIZE, ceilBoardGridValue(tallest));
}

/** Read the real header row rendered by CardNode/BranchCard. */
export function renderedZoneStackHeaderHeight(node: Node, fallbackHeight: number): number {
  if (typeof document === 'undefined') return fallbackHeight;
  const wrapper = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
  ).find((candidate) => candidate.dataset.id === node.id);
  if (!wrapper) return fallbackHeight;
  const header = wrapper.querySelector<HTMLElement>(ZONE_STACK_HEADER_SELECTOR);
  if (!header) return fallbackHeight;
  const wrapperRect = wrapper.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  // Include chrome before the header itself (notably Ant Card's body padding),
  // because the next node covers from the React Flow wrapper's top edge.
  const renderedStripHeight = headerRect.bottom - wrapperRect.top;
  const height = Math.max(
    renderedStripHeight,
    header.offsetTop + header.offsetHeight,
    header.scrollHeight
  );
  return Number.isFinite(height) && height > 0 ? height : fallbackHeight;
}

/** The visible strip of every covered item contains its complete header row. */
export function stackExposesHeaders(
  placements: readonly RectanglePlacement[],
  headerHeightById: ReadonlyMap<string, number>
): boolean {
  const byStack = new Map<number, RectanglePlacement[]>();
  for (const placement of placements) {
    const stack = byStack.get(placement.stackIndex) ?? [];
    stack.push(placement);
    byStack.set(placement.stackIndex, stack);
  }
  for (const stack of byStack.values()) {
    const ordered = [...stack].sort((a, b) => a.deckDepth - b.deckDepth);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (!current || !next) continue;
      if (next.y - current.y < (headerHeightById.get(current.id) ?? 0)) return false;
    }
  }
  return true;
}
