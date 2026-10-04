import type { CSSProperties } from 'react';
import type { Node, Viewport } from 'reactflow';
import {
  getVisibleSelectableNodeRect,
  isVisibleSelectableBoardNode,
  type NodeRect,
} from './boardNodeGeometry';

export interface LayoutRect extends NodeRect {
  id: string;
}

export interface LayoutGuide {
  id: string;
  orientation: 'vertical' | 'horizontal';
  /** Constant coordinate, in flow space. */
  offset: number;
  /** Local span along the guide's variable axis, in flow space. */
  start: number;
  end: number;
  kind: 'alignment' | 'size' | 'gap';
  label?: string;
  comparisonId?: string;
  /** Geometry used to keep the compact size readout outside the moving node. */
  readout?: {
    target: NodeRect;
    avoid: NodeRect[];
  };
}

export interface SnapResult {
  x: number;
  y: number;
  guides: LayoutGuide[];
}

/**
 * Consume the last geometry accepted by the controlled drag handler. React
 * Flow can report its pre-guide position in onNodeDragStop after a guide snap,
 * so the tracked position is authoritative for this one interaction only.
 */
export function consumeTrackedDragPosition(
  nodeId: string,
  eventPosition: { x: number; y: number },
  trackedPositions: Record<string, { x: number; y: number }>
): { x: number; y: number } {
  const trackedPosition = trackedPositions[nodeId];
  delete trackedPositions[nodeId];
  return trackedPosition ?? eventPosition;
}

interface AlignmentCandidate {
  delta: number;
  guide: number;
  peer: LayoutRect;
  sourceIndex: number;
  targetIndex: number;
}

interface GapNeighbor {
  peer: LayoutRect;
  gap: number;
}

export const GUIDE_SNAP_DISTANCE_PX = 8;
const GUIDE_DEDUPE_TOLERANCE = 0.5;
const SIZE_READOUT_GAP_PX = 6;
const SIZE_READOUT_HEIGHT_PX = 20;
const SIZE_READOUT_CHAR_WIDTH_PX = 6;
const SIZE_READOUT_HORIZONTAL_CHROME_PX = 12;
const SIZE_READOUT_VIEWPORT_INSET_PX = 4;

export interface GuideViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function flowSnapDistanceForZoom(zoom: number): number {
  return GUIDE_SNAP_DISTANCE_PX / Math.max(zoom, 0.01);
}

function compareCandidates(a: AlignmentCandidate, b: AlignmentCandidate): number {
  return (
    Math.abs(a.delta) - Math.abs(b.delta) ||
    a.guide - b.guide ||
    a.peer.id.localeCompare(b.peer.id) ||
    a.sourceIndex - b.sourceIndex ||
    a.targetIndex - b.targetIndex
  );
}

function nearestGap(candidates: GapNeighbor[]): GapNeighbor | undefined {
  return candidates.sort((a, b) => a.gap - b.gap || a.peer.id.localeCompare(b.peer.id))[0];
}

function guideSort(a: LayoutGuide, b: LayoutGuide): number {
  return (
    a.orientation.localeCompare(b.orientation) ||
    a.offset - b.offset ||
    a.kind.localeCompare(b.kind) ||
    a.start - b.start ||
    a.end - b.end ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Collapse guides that describe the same logical line/measurement. Alignment
 * guides dedupe by axis + coordinate (within half a flow pixel) and merge their
 * local extents. Measurement segments additionally include their span, so the
 * two intentionally separate halves of an equal-gap comparison survive.
 */
export function dedupeLayoutGuides(
  guides: LayoutGuide[],
  tolerance = GUIDE_DEDUPE_TOLERANCE
): LayoutGuide[] {
  const result: LayoutGuide[] = [];
  for (const guide of [...guides].sort(guideSort)) {
    const start = Math.min(guide.start, guide.end);
    const end = Math.max(guide.start, guide.end);
    if (![guide.offset, start, end].every(Number.isFinite) || end <= start) continue;

    const duplicate = result.find(
      (existing) =>
        existing.orientation === guide.orientation &&
        existing.kind === guide.kind &&
        Math.abs(existing.offset - guide.offset) <= tolerance &&
        (guide.kind === 'alignment' ||
          (Math.abs(existing.start - start) <= tolerance &&
            Math.abs(existing.end - end) <= tolerance &&
            existing.comparisonId === guide.comparisonId))
    );
    if (!duplicate) {
      result.push({ ...guide, start, end });
      continue;
    }
    if (guide.kind === 'alignment') {
      duplicate.start = Math.min(duplicate.start, start);
      duplicate.end = Math.max(duplicate.end, end);
    }
    if (!duplicate.label && guide.label) duplicate.label = guide.label;
  }
  return result;
}

/** Convert a flow-space guide segment into a screen-space, fixed-weight line. */
export function layoutGuideScreenStyle(guide: LayoutGuide, viewport: Viewport): CSSProperties {
  const start = Math.min(guide.start, guide.end);
  const length = Math.abs(guide.end - guide.start) * viewport.zoom;
  if (guide.orientation === 'vertical') {
    return {
      left: guide.offset * viewport.zoom + viewport.x,
      top: start * viewport.zoom + viewport.y,
      height: length,
    };
  }
  return {
    left: start * viewport.zoom + viewport.x,
    top: guide.offset * viewport.zoom + viewport.y,
    width: length,
  };
}

interface ReadoutCandidate {
  left: number;
  top: number;
  preference: number;
}

function intersectionArea(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): number {
  return (
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  );
}

/**
 * Place a size badge beside its target in screen space. The badge keeps a
 * fixed screen-pixel footprint at every zoom, tries bottom/top/right/left in
 * that order, and prefers the first viewport-contained position that does not
 * cover a peer. Returning absolute screen coordinates also keeps a badge wider
 * than a tiny node from being positioned relative to (and clipped by) it.
 */
export function layoutSizeReadoutScreenStyle(
  guide: LayoutGuide,
  viewport: Viewport,
  bounds: GuideViewportBounds
): CSSProperties | undefined {
  if (guide.kind !== 'size' || !guide.label || !guide.readout) return undefined;

  const { target, avoid } = guide.readout;
  const targetScreen = {
    left: target.x * viewport.zoom + viewport.x,
    top: target.y * viewport.zoom + viewport.y,
    right: (target.x + target.width) * viewport.zoom + viewport.x,
    bottom: (target.y + target.height) * viewport.zoom + viewport.y,
  };
  const width = Math.min(
    Math.max(0, bounds.right - bounds.left - SIZE_READOUT_VIEWPORT_INSET_PX * 2),
    guide.label.length * SIZE_READOUT_CHAR_WIDTH_PX + SIZE_READOUT_HORIZONTAL_CHROME_PX
  );
  if (width <= 0 || bounds.bottom <= bounds.top) return undefined;

  const minLeft = bounds.left + SIZE_READOUT_VIEWPORT_INSET_PX;
  const maxLeft = bounds.right - SIZE_READOUT_VIEWPORT_INSET_PX - width;
  const minTop = bounds.top + SIZE_READOUT_VIEWPORT_INSET_PX;
  const maxTop = bounds.bottom - SIZE_READOUT_VIEWPORT_INSET_PX - SIZE_READOUT_HEIGHT_PX;
  const centerLeft = Math.min(
    maxLeft,
    Math.max(minLeft, (targetScreen.left + targetScreen.right - width) / 2)
  );
  const centerTop = Math.min(
    maxTop,
    Math.max(minTop, (targetScreen.top + targetScreen.bottom - SIZE_READOUT_HEIGHT_PX) / 2)
  );
  const candidates: ReadoutCandidate[] = [
    { left: centerLeft, top: targetScreen.bottom + SIZE_READOUT_GAP_PX, preference: 0 },
    {
      left: centerLeft,
      top: targetScreen.top - SIZE_READOUT_GAP_PX - SIZE_READOUT_HEIGHT_PX,
      preference: 1,
    },
    { left: targetScreen.right + SIZE_READOUT_GAP_PX, top: centerTop, preference: 2 },
    { left: targetScreen.left - SIZE_READOUT_GAP_PX - width, top: centerTop, preference: 3 },
  ];
  const peerScreens = avoid.map((peer) => ({
    left: peer.x * viewport.zoom + viewport.x,
    top: peer.y * viewport.zoom + viewport.y,
    right: (peer.x + peer.width) * viewport.zoom + viewport.x,
    bottom: (peer.y + peer.height) * viewport.zoom + viewport.y,
  }));
  const contained = candidates.filter(
    (candidate) =>
      candidate.left >= minLeft &&
      candidate.left + width <= bounds.right - SIZE_READOUT_VIEWPORT_INSET_PX &&
      candidate.top >= minTop &&
      candidate.top + SIZE_READOUT_HEIGHT_PX <= bounds.bottom - SIZE_READOUT_VIEWPORT_INSET_PX
  );
  const candidate = contained.sort((a, b) => {
    const rectFor = (value: ReadoutCandidate) => ({
      left: value.left,
      top: value.top,
      right: value.left + width,
      bottom: value.top + SIZE_READOUT_HEIGHT_PX,
    });
    const aOverlap = peerScreens.reduce(
      (total, peer) => total + intersectionArea(rectFor(a), peer),
      0
    );
    const bOverlap = peerScreens.reduce(
      (total, peer) => total + intersectionArea(rectFor(b), peer),
      0
    );
    return aOverlap - bOverlap || a.preference - b.preference;
  })[0];
  if (!candidate) return undefined;

  return {
    left: candidate.left,
    top: candidate.top,
    width,
    height: SIZE_READOUT_HEIGHT_PX,
  };
}

function isDescendantOf(node: Node, ancestorId: string, nodesById: Map<string, Node>): boolean {
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = nodesById.get(parentId)?.parentId;
  }
  return false;
}

/** Build absolute flow-space rectangles for the real node-drag production path. */
export function getGuideLayoutRects(
  movingNode: Node,
  nodes: Node[]
): { moving: LayoutRect; peers: LayoutRect[] } | null {
  if (!isVisibleSelectableBoardNode(movingNode)) return null;
  const movingRect = getVisibleSelectableNodeRect(movingNode, nodes);
  if (!movingRect) return null;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const peers = nodes
    .filter(
      (peer) =>
        peer.id !== movingNode.id &&
        !peer.selected &&
        !isDescendantOf(peer, movingNode.id, nodesById)
    )
    .map((peer): LayoutRect | null => {
      const rect = getVisibleSelectableNodeRect(peer, nodes);
      return rect ? { id: peer.id, ...rect } : null;
    })
    .filter((peer): peer is LayoutRect => peer !== null);
  return { moving: { id: movingNode.id, ...movingRect }, peers };
}

/** Snap a moving rectangle to nearby peer edges/centers and return local tool guides. */
export function snapRectToPeers(
  moving: LayoutRect,
  peers: LayoutRect[],
  threshold = GUIDE_SNAP_DISTANCE_PX
): SnapResult {
  const xCandidates: AlignmentCandidate[] = [];
  const yCandidates: AlignmentCandidate[] = [];
  const movingX = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const movingY = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  for (const peer of [...peers].sort((a, b) => a.id.localeCompare(b.id))) {
    const peerX = [peer.x, peer.x + peer.width / 2, peer.x + peer.width];
    const peerY = [peer.y, peer.y + peer.height / 2, peer.y + peer.height];
    movingX.forEach((source, sourceIndex) => {
      peerX.forEach((target, targetIndex) => {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) {
          xCandidates.push({ delta, guide: target, peer, sourceIndex, targetIndex });
        }
      });
    });
    movingY.forEach((source, sourceIndex) => {
      peerY.forEach((target, targetIndex) => {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) {
          yCandidates.push({ delta, guide: target, peer, sourceIndex, targetIndex });
        }
      });
    });
  }

  const bestX = xCandidates.sort(compareCandidates)[0];
  const bestY = yCandidates.sort(compareCandidates)[0];
  const snapped: LayoutRect = {
    ...moving,
    x: moving.x + (bestX?.delta ?? 0),
    y: moving.y + (bestY?.delta ?? 0),
  };
  const guides: LayoutGuide[] = [];

  if (bestX) {
    guides.push({
      id: `align-x-${bestX.guide}-${bestX.peer.id}`,
      orientation: 'vertical',
      offset: bestX.guide,
      start: Math.min(snapped.y, bestX.peer.y),
      end: Math.max(snapped.y + snapped.height, bestX.peer.y + bestX.peer.height),
      kind: 'alignment',
    });
  }
  if (bestY) {
    guides.push({
      id: `align-y-${bestY.guide}-${bestY.peer.id}`,
      orientation: 'horizontal',
      offset: bestY.guide,
      start: Math.min(snapped.x, bestY.peer.x),
      end: Math.max(snapped.x + snapped.width, bestY.peer.x + bestY.peer.width),
      kind: 'alignment',
    });
  }

  const byWidth = [...peers].sort(
    (a, b) =>
      Math.abs(a.width - snapped.width) - Math.abs(b.width - snapped.width) ||
      a.id.localeCompare(b.id)
  );
  const byHeight = [...peers].sort(
    (a, b) =>
      Math.abs(a.height - snapped.height) - Math.abs(b.height - snapped.height) ||
      a.id.localeCompare(b.id)
  );
  const widthMatches = !!byWidth[0] && Math.abs(byWidth[0].width - snapped.width) <= threshold;
  const heightMatches = !!byHeight[0] && Math.abs(byHeight[0].height - snapped.height) <= threshold;
  if (widthMatches || heightMatches) {
    guides.push({
      id: `size-${snapped.id}`,
      orientation: 'horizontal',
      // The single measurement line rides the lower edge rather than crossing
      // the node body. Its badge is rendered separately, outside this rect.
      offset: snapped.y + snapped.height,
      start: snapped.x,
      end: snapped.x + snapped.width,
      kind: 'size',
      label: `${Math.round(snapped.width)} × ${Math.round(snapped.height)}`,
      readout: {
        target: snapped,
        avoid: peers,
      },
    });
  }

  const overlapsY = (peer: LayoutRect) =>
    peer.y < snapped.y + snapped.height && peer.y + peer.height > snapped.y;
  const overlapsX = (peer: LayoutRect) =>
    peer.x < snapped.x + snapped.width && peer.x + peer.width > snapped.x;
  const left = nearestGap(
    peers
      .filter((peer) => peer.x + peer.width <= snapped.x && overlapsY(peer))
      .map((peer) => ({ peer, gap: snapped.x - (peer.x + peer.width) }))
  );
  const right = nearestGap(
    peers
      .filter((peer) => peer.x >= snapped.x + snapped.width && overlapsY(peer))
      .map((peer) => ({ peer, gap: peer.x - (snapped.x + snapped.width) }))
  );
  const above = nearestGap(
    peers
      .filter((peer) => peer.y + peer.height <= snapped.y && overlapsX(peer))
      .map((peer) => ({ peer, gap: snapped.y - (peer.y + peer.height) }))
  );
  const below = nearestGap(
    peers
      .filter((peer) => peer.y >= snapped.y + snapped.height && overlapsX(peer))
      .map((peer) => ({ peer, gap: peer.y - (snapped.y + snapped.height) }))
  );

  if (left && right && left.gap > 0 && Math.abs(left.gap - right.gap) <= threshold) {
    const comparisonId = `gap-x-${left.peer.id}-${snapped.id}-${right.peer.id}`;
    const label = `${Math.round((left.gap + right.gap) / 2)}px`;
    const offset = snapped.y + snapped.height / 2;
    guides.push(
      {
        id: `${comparisonId}-left`,
        orientation: 'horizontal',
        offset,
        start: left.peer.x + left.peer.width,
        end: snapped.x,
        kind: 'gap',
        label,
        comparisonId,
      },
      {
        id: `${comparisonId}-right`,
        orientation: 'horizontal',
        offset,
        start: snapped.x + snapped.width,
        end: right.peer.x,
        kind: 'gap',
        label,
        comparisonId,
      }
    );
  }
  if (above && below && above.gap > 0 && Math.abs(above.gap - below.gap) <= threshold) {
    const comparisonId = `gap-y-${above.peer.id}-${snapped.id}-${below.peer.id}`;
    const label = `${Math.round((above.gap + below.gap) / 2)}px`;
    const offset = snapped.x + snapped.width / 2;
    guides.push(
      {
        id: `${comparisonId}-above`,
        orientation: 'vertical',
        offset,
        start: above.peer.y + above.peer.height,
        end: snapped.y,
        kind: 'gap',
        label,
        comparisonId,
      },
      {
        id: `${comparisonId}-below`,
        orientation: 'vertical',
        offset,
        start: snapped.y + snapped.height,
        end: below.peer.y,
        kind: 'gap',
        label,
        comparisonId,
      }
    );
  }

  return { x: snapped.x, y: snapped.y, guides: dedupeLayoutGuides(guides) };
}
