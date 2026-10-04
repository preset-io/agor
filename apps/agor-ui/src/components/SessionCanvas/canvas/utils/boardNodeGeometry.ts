import type { Node } from 'reactflow';
import { getNodeAbsolutePosition } from './coordinateTransforms';

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getRenderedNodeSize(node: Node): { width: number; height: number } {
  return {
    width: Number(node.width ?? node.style?.width ?? node.data?.width ?? 0),
    height: Number(node.height ?? node.style?.height ?? node.data?.height ?? 0),
  };
}

/** Measure the real outer box used by explicit layout without changing marquee hit-testing. */
export function getMeasuredLayoutNodeSize(
  node: Node,
  fallback: { width: number; height: number } = { width: 0, height: 0 }
): { width: number; height: number } {
  const stored = {
    width: Number(node.width ?? node.style?.width ?? node.data?.width ?? fallback.width),
    height: Number(node.height ?? node.style?.height ?? node.data?.height ?? fallback.height),
  };
  if (typeof document === 'undefined') return stored;

  const element = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
  ).find((candidate) => candidate.dataset.id === node.id);
  if (!element) return stored;
  const width = Math.max(element.offsetWidth, element.scrollWidth);
  const height = Math.max(element.offsetHeight, element.scrollHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : stored.width,
    height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : stored.height,
  };
}

/**
 * Eligibility shared by marquee hit-testing and design-guide geometry.
 *
 * Deliberately use React Flow's behavioral flags instead of a node-type allow
 * list: branches, cards, zones, notes, apps, artifacts, and future movable
 * board entities should all get the same interaction without another switch.
 */
export function isVisibleSelectableBoardNode(node: Node): boolean {
  return (
    !node.hidden &&
    node.selectable !== false &&
    node.draggable !== false &&
    node.data?.locked !== true
  );
}

export function getVisibleSelectableNodeRect(node: Node, nodes: Node[]): NodeRect | null {
  if (!isVisibleSelectableBoardNode(node)) return null;
  const { width, height } = getRenderedNodeSize(node);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { ...getNodeAbsolutePosition(node, nodes), width, height };
}
