import type { Node } from 'reactflow';

export type PostLayoutViewportSource = 'user' | 'auto' | 'realtime';
export type PostLayoutViewportScope = 'board' | 'selection' | 'zone';
export type PostLayoutViewportMode = 'smart' | 'fit' | 'preserve';

export function arrangeBoardViewportMode(fitViewAfterArranging: boolean): PostLayoutViewportMode {
  return fitViewAfterArranging ? 'fit' : 'preserve';
}

export interface LayoutNodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PostLayoutViewportIntent {
  source: PostLayoutViewportSource;
  boardId: string;
  scope: PostLayoutViewportScope;
  /** Smart policy by default; explicit whole-board Arrange may force or suppress one fit. */
  mode: PostLayoutViewportMode;
  before: readonly LayoutNodeRect[];
  after: readonly LayoutNodeRect[];
}

export interface LayoutViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PostLayoutViewportDecisionInput {
  intent: PostLayoutViewportIntent;
  viewport: LayoutViewportBounds;
  viewportPixels: { width: number; height: number };
  zoom: number;
}

export interface PostLayoutViewportDecision {
  fit: boolean;
  reason:
    | 'not-user'
    | 'preserve-requested'
    | 'fit-requested'
    | 'no-material-change'
    | 'comfortable'
    | 'clipped'
    | 'scale';
  padding: number;
}

interface PendingPostLayoutViewport {
  token: number;
  intent: PostLayoutViewportIntent;
}

/**
 * Invocation-order fence for the shared post-layout viewport path. A layout
 * reserves a token before its first async write. Direct manipulation cancels
 * that token, and completion may queue only while it is still current.
 */
export class PostLayoutViewportCoordinator {
  private token = 0;
  private pending: PendingPostLayoutViewport | undefined;

  begin(): number {
    this.token += 1;
    this.pending = undefined;
    return this.token;
  }

  cancel(): void {
    this.begin();
  }

  queue(intent: PostLayoutViewportIntent, token?: number): PendingPostLayoutViewport | undefined {
    const resolvedToken = token ?? this.begin();
    if (resolvedToken !== this.token) return undefined;
    this.pending = { token: resolvedToken, intent };
    return this.pending;
  }

  peek(token: number): PendingPostLayoutViewport | undefined {
    return this.pending?.token === token ? this.pending : undefined;
  }

  consume(token: number): PostLayoutViewportIntent | undefined {
    const pending = this.peek(token);
    if (!pending) return undefined;
    this.pending = undefined;
    return pending.intent;
  }

  discard(token: number): void {
    if (this.pending?.token === token) this.pending = undefined;
  }
}

export interface SettledPostLayoutViewportInput {
  coordinator: PostLayoutViewportCoordinator;
  token: number;
  currentNodes: readonly Node[];
  viewport: LayoutViewportBounds;
  viewportPixels: { width: number; height: number };
  zoom: number;
  reducedMotion: boolean;
}

export interface SettledPostLayoutViewportFit {
  nodes: Node[];
  padding: number;
  minZoom: number;
  maxZoom: number;
  duration: number;
}

const MATERIAL_GEOMETRY_DELTA = 8;
const COMFORT_MARGIN_PX = 48;
const MIN_COMFORTABLE_OCCUPANCY = 0.18;
const MAX_COMFORTABLE_OCCUPANCY = 0.9;
const SNAPSHOT_TOLERANCE = 1;

function nodeDimension(node: Node, key: 'width' | 'height'): number {
  const measured = (node as Node & { measured?: { width?: number; height?: number } }).measured;
  // Explicit planner output wins while React Flow's measured cache catches up.
  const value = Number(node[key] ?? node.style?.[key] ?? measured?.[key] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function absolutePosition(
  node: Node,
  byId: ReadonlyMap<string, Node>,
  seen: ReadonlySet<string> = new Set()
): { x: number; y: number } {
  if (!node.parentId || seen.has(node.id)) return node.position;
  const parent = byId.get(node.parentId);
  if (!parent) return node.position;
  const nextSeen = new Set(seen);
  nextSeen.add(node.id);
  const parentPosition = absolutePosition(parent, byId, nextSeen);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

/** Capture stable absolute geometry without trusting a pre-render positionAbsolute. */
export function snapshotLayoutNodes(
  nodes: readonly Node[],
  affectedNodeIds: readonly string[]
): LayoutNodeRect[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return [...new Set(affectedNodeIds)].flatMap((id) => {
    const node = byId.get(id);
    if (!node || node.hidden) return [];
    const position = absolutePosition(node, byId);
    return [
      {
        id,
        ...position,
        width: nodeDimension(node, 'width'),
        height: nodeDimension(node, 'height'),
      },
    ];
  });
}

export function layoutSnapshotsMatch(
  expected: readonly LayoutNodeRect[],
  actual: readonly LayoutNodeRect[],
  tolerance = SNAPSHOT_TOLERANCE
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(actual.map((rect) => [rect.id, rect]));
  return expected.every((rect) => {
    const candidate = actualById.get(rect.id);
    return (
      candidate !== undefined &&
      Math.abs(rect.x - candidate.x) <= tolerance &&
      Math.abs(rect.y - candidate.y) <= tolerance &&
      Math.abs(rect.width - candidate.width) <= tolerance &&
      Math.abs(rect.height - candidate.height) <= tolerance
    );
  });
}

/**
 * Confirm that the persisted layout has settled at the requested positions.
 * Rendered card heights can legitimately converge after persistence (for
 * example when compact content paints), so callers that will consume the
 * fresh settled rectangles should not reject that newer size information.
 */
export function layoutPositionsMatch(
  expected: readonly LayoutNodeRect[],
  actual: readonly LayoutNodeRect[],
  tolerance = SNAPSHOT_TOLERANCE
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(actual.map((rect) => [rect.id, rect]));
  return expected.every((rect) => {
    const candidate = actualById.get(rect.id);
    return (
      candidate !== undefined &&
      Math.abs(rect.x - candidate.x) <= tolerance &&
      Math.abs(rect.y - candidate.y) <= tolerance
    );
  });
}

export function layoutGeometryChanged(
  before: readonly LayoutNodeRect[],
  after: readonly LayoutNodeRect[],
  threshold = 0.5
): boolean {
  if (before.length !== after.length) return true;
  const beforeById = new Map(before.map((rect) => [rect.id, rect]));
  return after.some((rect) => {
    const previous = beforeById.get(rect.id);
    return (
      previous === undefined ||
      Math.abs(previous.x - rect.x) >= threshold ||
      Math.abs(previous.y - rect.y) >= threshold ||
      Math.abs(previous.width - rect.width) >= threshold ||
      Math.abs(previous.height - rect.height) >= threshold
    );
  });
}

function boundsFor(rects: readonly LayoutNodeRect[]): LayoutViewportBounds | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.x)),
    top: Math.min(...rects.map((rect) => rect.y)),
    right: Math.max(...rects.map((rect) => rect.x + rect.width)),
    bottom: Math.max(...rects.map((rect) => rect.y + rect.height)),
  };
}

/** Pure policy shared by every explicit layout surface. */
export function decidePostLayoutViewport(
  input: PostLayoutViewportDecisionInput
): PostLayoutViewportDecision {
  const padding = input.intent.scope === 'board' ? 0.12 : 0.16;
  if (input.intent.source !== 'user') return { fit: false, reason: 'not-user', padding };
  if (input.intent.mode === 'preserve') {
    return { fit: false, reason: 'preserve-requested', padding };
  }
  if (input.intent.mode === 'fit') return { fit: true, reason: 'fit-requested', padding };
  if (!layoutGeometryChanged(input.intent.before, input.intent.after, MATERIAL_GEOMETRY_DELTA)) {
    return { fit: false, reason: 'no-material-change', padding };
  }

  const bounds = boundsFor(input.intent.after);
  if (
    !bounds ||
    input.zoom <= 0 ||
    input.viewportPixels.width <= 0 ||
    input.viewportPixels.height <= 0
  ) {
    return { fit: false, reason: 'comfortable', padding };
  }
  const margin = COMFORT_MARGIN_PX / input.zoom;
  const comfortablyVisible =
    bounds.left >= input.viewport.left + margin &&
    bounds.top >= input.viewport.top + margin &&
    bounds.right <= input.viewport.right - margin &&
    bounds.bottom <= input.viewport.bottom - margin;
  const occupiedWidth = ((bounds.right - bounds.left) * input.zoom) / input.viewportPixels.width;
  const occupiedHeight = ((bounds.bottom - bounds.top) * input.zoom) / input.viewportPixels.height;
  const occupancy = Math.max(occupiedWidth, occupiedHeight);
  const impracticalScale =
    occupancy < MIN_COMFORTABLE_OCCUPANCY || occupancy > MAX_COMFORTABLE_OCCUPANCY;

  if (!comfortablyVisible) return { fit: true, reason: 'clipped', padding };
  if (impracticalScale) return { fit: true, reason: 'scale', padding };
  return { fit: false, reason: 'comfortable', padding };
}

/**
 * Consume one settled request. Position matching proves the rendered graph is
 * the transaction that queued the request; fresh rendered sizes remain valid
 * inputs so content can finish measuring before the single fit is calculated.
 */
export function consumeSettledPostLayoutViewport(
  input: SettledPostLayoutViewportInput
): SettledPostLayoutViewportFit | null {
  const pending = input.coordinator.peek(input.token);
  if (!pending) return null;

  const affectedIds = pending.intent.after.map((rect) => rect.id);
  const settled = snapshotLayoutNodes(input.currentNodes, affectedIds);
  if (!layoutPositionsMatch(pending.intent.after, settled)) {
    input.coordinator.discard(input.token);
    return null;
  }

  const intent = input.coordinator.consume(input.token);
  if (!intent) return null;
  const decision = decidePostLayoutViewport({
    intent: { ...intent, after: settled },
    viewport: input.viewport,
    viewportPixels: input.viewportPixels,
    zoom: input.zoom,
  });
  if (!decision.fit) return null;

  const affectedIdSet = new Set(affectedIds);
  const nodes = input.currentNodes.filter((node) => affectedIdSet.has(node.id) && !node.hidden);
  if (nodes.length === 0) return null;
  return {
    nodes,
    padding: decision.padding,
    minZoom: 0.1,
    maxZoom: 1,
    duration: input.reducedMotion ? 0 : 300,
  };
}

export function createPostLayoutViewportIntent(input: {
  source: PostLayoutViewportSource;
  boardId: string;
  scope: PostLayoutViewportScope;
  mode?: PostLayoutViewportMode;
  beforeNodes: readonly Node[];
  afterNodes: readonly Node[];
  affectedNodeIds: readonly string[];
}): PostLayoutViewportIntent {
  return {
    source: input.source,
    boardId: input.boardId,
    scope: input.scope,
    mode: input.mode ?? 'smart',
    before: snapshotLayoutNodes(input.beforeNodes, input.affectedNodeIds),
    after: snapshotLayoutNodes(input.afterNodes, input.affectedNodeIds),
  };
}
