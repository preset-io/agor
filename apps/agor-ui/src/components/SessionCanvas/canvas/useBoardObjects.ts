/**
 * Hook for managing board objects (text labels, zones, etc.)
 */

import {
  type BoardZoneArrangementOptions,
  containingBoardZoneId,
  planBoardZoneArrangement,
} from '@agor/core/layout/board-zone-arrangement';
import { ceilBoardGridSize, LayoutObstacleError } from '@agor/core/layout/rectangle-packing';
import { planZoneGrowthReflow } from '@agor/core/layout/zone-growth-reflow';
import {
  compactZoneItemSize,
  estimateExpandedGenericCardHeight,
  GENERIC_BOARD_CARD_LAYOUT,
  getZoneLayoutFrame,
  isBoardEntityDensityExpandable,
  justifyZoneContentCluster,
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneContentJustification,
  type ZoneLayoutSortItem,
} from '@agor/core/layout/zone-layout';
import type { BoardLayoutApplyResult, BoardLayoutBatch } from '@agor/core/types';
import type { AgorClient, Board, BoardEntityObject, BoardObject, Card } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { useThemedMessage } from '../../../utils/message';
import { dealDelayMs, dealOrderIndex, dealStyle, dealTiming } from './arrangeAnimation';
import { AutoZoneDeferral } from './autoZoneDeferral';
import {
  type AutoZoneObserverInput,
  type AutoZoneObserverLockManager,
  autoZoneObserverSignature,
  changedAutoZoneObserverIds,
  holdAutoZoneObserverLease,
} from './autoZoneObserver';
import {
  type AuthoritativeLayoutSource,
  fetchAuthoritativeLayoutSource,
  isBoardLayoutSnapshotStale,
  MAX_LAYOUT_STALE_REPLANS,
} from './layoutConflictRecovery';
import {
  createPostLayoutViewportIntent,
  type PostLayoutViewportIntent,
  type PostLayoutViewportMode,
} from './postLayoutViewport';
import {
  type ExpectedAutoLayoutSignature,
  expectedAutoLayoutState,
  layoutResultCoversBatch,
  zonesNeedingAutoArrange,
} from './utils/autoArrangeGuard';
import { getNodeAbsolutePosition } from './utils/coordinateTransforms';
import {
  renderedZoneStackHeaderHeight,
  stackExposesHeaders,
  type ZoneStackPresentation,
  zoneStackRevealHeight,
} from './zoneStack';

// Long enough for the expanded cards to paint before the re-pack measures
// them; short enough that the board does not visibly sit in a broken state.
const EXPANDED_REPACK_DELAY_MS = 400;
const AUTO_ZONE_BASE_DELAY_MS = 120;
const CALLED_OUT_ZONE_STACK_Z_INDEX = 900;

const autoZoneObserverSortData = (node: Node): readonly unknown[] => {
  const data = node.data as {
    branch?: {
      name?: string;
      created_at?: string;
      updated_at?: string;
      filesystem_status?: string;
    };
    card?: {
      title?: string;
      created_at?: string;
      updated_at?: string;
      data?: Record<string, unknown>;
    };
  };
  return [
    data.branch?.name,
    data.branch?.created_at,
    data.branch?.updated_at,
    data.branch?.filesystem_status,
    data.card?.title,
    data.card?.created_at,
    data.card?.updated_at,
    data.card?.data?.priority,
    data.card?.data?.rank,
    data.card?.data?.status,
  ];
};

const placementNodeId = (placement: BoardEntityObject): string | undefined =>
  placement.branch_id ?? (placement.card_id ? `card-${placement.card_id}` : undefined);

const expectedLayoutSnapshot = (
  board: Board,
  placementsById: ReadonlyMap<string, BoardEntityObject>
): NonNullable<BoardLayoutBatch['expected']> => ({
  objects: Object.fromEntries(
    Object.entries(board.objects ?? {}).map(([id, object]) => {
      return [
        id,
        {
          x: object.x,
          y: object.y,
          ...('width' in object ? { width: object.width } : {}),
          ...('height' in object ? { height: object.height } : {}),
        },
      ];
    })
  ),
  placements: Object.fromEntries(
    [...placementsById].map(([id, placement]) => {
      return [
        id,
        {
          position: placement.position,
          ...(placement.size ? { size: placement.size } : {}),
          ...(placement.compact === undefined ? {} : { compact: placement.compact }),
        },
      ];
    })
  ),
});

const densityCardForNode = (node: Node | undefined): Card | undefined =>
  node?.type === 'cardNode' ? ((node.data as { card?: Card }).card ?? undefined) : undefined;

const isDensityExpandableNode = (node: Node): boolean =>
  node.type === 'branchNode' ||
  (node.type === 'cardNode' && isBoardEntityDensityExpandable('card', densityCardForNode(node)));

const isDensityExpandablePlacement = (
  placement: BoardEntityObject,
  node: Node | undefined,
  card?: Card
): boolean =>
  isBoardEntityDensityExpandable(placement.entity_type, card ?? densityCardForNode(node));

const expandedDensitySize = (node: Node): { width: number; height: number } =>
  ceilBoardGridSize(
    node.type === 'cardNode'
      ? {
          width: GENERIC_BOARD_CARD_LAYOUT.width,
          height: estimateExpandedGenericCardHeight(densityCardForNode(node)),
        }
      : { width: 500, height: 200 }
  );

import { getMeasuredLayoutNodeSize } from './utils/boardNodeGeometry';
import type { ReactFlowNode } from './utils/reactFlowTypes';

const canonicalAutoZoneItemSize = (
  node: Node,
  placement: BoardEntityObject | undefined,
  object: BoardObject | undefined,
  useRendered: boolean
) => {
  const rendered = renderedNodeSize(node);
  if (useRendered) return ceilBoardGridSize(rendered);
  const objectWidth = object && 'width' in object ? Number(object.width) : undefined;
  const objectHeight = object && 'height' in object ? Number(object.height) : undefined;
  return ceilBoardGridSize({
    width:
      placement?.size?.width ??
      (typeof objectWidth === 'number' && Number.isFinite(objectWidth) && objectWidth > 0
        ? objectWidth
        : rendered.width),
    height:
      placement?.size?.height ??
      (typeof objectHeight === 'number' && Number.isFinite(objectHeight) && objectHeight > 0
        ? objectHeight
        : rendered.height),
  });
};

import {
  computeLayerChanges,
  DEFAULT_BOARD_OBJECT_Z_INDEX,
  type LayerOp,
  sanitizeZIndex,
} from './zOrder';

function renderedNodeSize(node: Node): { width: number; height: number } {
  const measured = (node as ReactFlowNode).measured;
  return getMeasuredLayoutNodeSize(node, {
    width: Number(measured?.width ?? 380),
    height: Number(measured?.height ?? 120),
  });
}

/**
 * Zone titles stay a constant screen size while the board zooms. Convert that
 * rendered size back into board units for one explicit layout pass so children
 * cannot be packed underneath a large title. Missing DOM measurements retain
 * the shared core/MCP fallback scale of 1.
 */
function renderedZoneFontScale(zoneId: string, flowWidth: number): number {
  if (typeof document === 'undefined' || !Number.isFinite(flowWidth) || flowWidth <= 0) return 1;
  const element = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node-zone[data-id]')
  ).find((candidate) => candidate.dataset.id === zoneId);
  const renderedWidth = element?.getBoundingClientRect().width ?? 0;
  if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) return 1;
  return flowWidth / renderedWidth;
}

const ZONE_CANVAS_NODE_TYPES = new Set(['markdown', 'appNode', 'artifactNode']);
const BOARD_ARRANGEABLE_NODE_TYPES = new Set(['branchNode', 'cardNode', ...ZONE_CANVAS_NODE_TYPES]);

function isTopLevelZoneCanvasNode(node: Node): boolean {
  return !node.parentId && ZONE_CANVAS_NODE_TYPES.has(node.type ?? '');
}

function isPositionableZoneCanvasNode(node: Node): boolean {
  return !node.hidden && isTopLevelZoneCanvasNode(node) && node.data?.locked !== true;
}

function isArrangeableTopLevelNode(node: Node): boolean {
  return (
    !node.hidden &&
    !node.parentId &&
    BOARD_ARRANGEABLE_NODE_TYPES.has(node.type ?? '') &&
    node.data?.locked !== true
  );
}

function isVisibleBoardNode(node: Node): boolean {
  return !node.hidden && BOARD_ARRANGEABLE_NODE_TYPES.has(node.type ?? '');
}

function nodeCenterInsideZone(
  node: Node,
  zone: { x: number; y: number; width: number; height: number }
): boolean {
  const size = renderedNodeSize(node);
  const centerX = node.position.x + size.width / 2;
  const centerY = node.position.y + size.height / 2;
  return (
    centerX >= zone.x &&
    centerX <= zone.x + zone.width &&
    centerY >= zone.y &&
    centerY <= zone.y + zone.height
  );
}

/**
 * Resolve one board-arrangement scope from the rendered graph. Canvas objects
 * are geometrically contained rather than parented, so classify them against
 * every zone before filtering the requested zone set. That keeps an object in
 * an unselected, hidden, or locked zone from being mistaken for a free item.
 */
function getBoardArrangementCandidates(
  currentBoard: Board,
  currentNodes: readonly Node[],
  requestedZoneIds?: ReadonlySet<string>,
  requestedRootIds?: ReadonlySet<string>
) {
  const currentNodeList = [...currentNodes];
  const liveById = new Map(currentNodeList.map((node) => [node.id, node]));
  const allZones = Object.entries(currentBoard.objects ?? {}).flatMap(([zoneId, object]) => {
    if (object.type !== 'zone') return [];
    const live = liveById.get(zoneId);
    const width = Number(live?.width ?? live?.style?.width);
    const height = Number(live?.height ?? live?.style?.height);
    return [
      [
        zoneId,
        {
          ...object,
          x: live?.position.x ?? object.x,
          y: live?.position.y ?? object.y,
          width: Number.isFinite(width) && width > 0 ? width : object.width,
          height: Number.isFinite(height) && height > 0 ? height : object.height,
          fontSize: typeof live?.data?.fontSize === 'number' ? live.data.fontSize : object.fontSize,
          status: typeof live?.data?.status === 'string' ? live.data.status : object.status,
        },
      ] as const,
    ];
  });
  const zoneForCanvasNode = new Map<string, string>();
  const membershipZones = allZones.map(([id, zone]) => ({ id, ...zone }));
  for (const node of currentNodes) {
    if (!isTopLevelZoneCanvasNode(node)) continue;
    const zoneId = containingBoardZoneId(
      { ...node.position, ...renderedNodeSize(node) },
      membershipZones
    );
    if (zoneId) zoneForCanvasNode.set(node.id, zoneId);
  }

  // A locked/hidden canvas object has absolute coordinates. Moving its zone
  // without moving the object would silently break membership, so preserve the
  // complete zone rather than offering a partially effective arrangement.
  const blockedZoneIds = new Set<string>();
  for (const node of currentNodes) {
    if (!node.hidden && node.data?.locked !== true) continue;
    const zoneId =
      node.parentId ??
      (isTopLevelZoneCanvasNode(node) ? zoneForCanvasNode.get(node.id) : undefined);
    if (zoneId) blockedZoneIds.add(zoneId);
  }

  const selectedZones = allZones.filter(([zoneId]) => {
    const live = liveById.get(zoneId);
    return (
      (!requestedZoneIds || requestedZoneIds.has(zoneId)) &&
      Boolean(live) &&
      !live?.hidden &&
      live?.data?.locked !== true &&
      !blockedZoneIds.has(zoneId)
    );
  });
  const looseNodes = currentNodes.filter(
    (node) =>
      isArrangeableTopLevelNode(node) &&
      !zoneForCanvasNode.has(node.id) &&
      (!requestedRootIds || requestedRootIds.has(node.id))
  );
  const selectedZoneIds = new Set(selectedZones.map(([zoneId]) => zoneId));
  const selectedLooseIds = new Set(looseNodes.map((node) => node.id));
  const fixedObstacles = [
    ...allZones.flatMap(([zoneId, zone]) => {
      const live = liveById.get(zoneId);
      return !selectedZoneIds.has(zoneId) && live && !live.hidden
        ? [{ id: zoneId, x: zone.x, y: zone.y, width: zone.width, height: zone.height }]
        : [];
    }),
    ...currentNodes.flatMap((node) => {
      const containingZoneId = node.parentId ?? zoneForCanvasNode.get(node.id);
      if (
        !isVisibleBoardNode(node) ||
        selectedLooseIds.has(node.id) ||
        selectedZoneIds.has(containingZoneId ?? '')
      )
        return [];
      return [
        {
          id: node.id,
          ...getNodeAbsolutePosition(node, currentNodeList),
          ...ceilBoardGridSize(renderedNodeSize(node)),
        },
      ];
    }),
  ];

  return { selectedZones, zoneForCanvasNode, looseNodes, fixedObstacles };
}

interface UseBoardObjectsProps {
  board: Board | null;
  client: AgorClient | null;
  boardObjectsForBoard: BoardEntityObject[];
  nodes: Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  deletedObjectsRef: React.MutableRefObject<Set<string>>;
  eraserMode?: boolean;
  /** Artifact ID currently targeted by an `/a/<…>/` deep link. Used to
   *  flag the matching ArtifactNode so it can render the dashed
   *  "selected" outline. */
  activeUrlTargetArtifactId?: string | null;
  onEditMarkdown?: (objectId: string, content: string, width: number) => void;
  /** Hold optimistic placements and enable motion before realtime echoes arrive. */
  onArrangeNodes?: (nodes: Node[], totalMs: number) => void;
  /** Fence a user layout before persistence so later direct input wins. */
  onUserLayoutStart?: () => number;
  /** Queue one viewport decision after a persisted, explicitly requested layout. */
  onUserLayoutComplete?: (intent: PostLayoutViewportIntent, intentToken?: number) => void;
  /** Effective board.edit permission, resolved by the canvas. */
  canEdit?: boolean;
}

function zonesOverlap(
  a: Extract<BoardObject, { type: 'zone' }>,
  b: Extract<BoardObject, { type: 'zone' }>
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

interface ArrangeZoneContentsOptions {
  silent?: boolean;
  preserveZoneFrame?: boolean;
  userInitiated?: boolean;
  /** Synchronous owner token required for background writes only. */
  observerLease?: AutoZoneObserverLease;
  /** Internal bounded-conflict recovery state; never exposed by UI controls. */
  recovery?: LayoutRecoveryState;
}

interface AutoZoneObserverLease {
  boardId: string | undefined;
  owned: boolean;
}

interface LayoutIntentToken {
  epoch: number;
  scope: 'board' | 'zone';
  key: string;
  generation: number;
}

interface LayoutRecoveryState {
  attempt: number;
  intent: LayoutIntentToken;
  source: AuthoritativeLayoutSource;
  viewportIntentToken?: number;
}

type ArrangeBoardZonesOptions = Omit<BoardZoneArrangementOptions, 'looseItems'> & {
  userInitiated?: boolean;
  /** Whole-board layout includes free peers; selection layout never does. */
  layoutScope?: 'board' | 'selection';
  /** Selection-scoped top-level roots. Whole-board callers omit this. */
  selectedRootIds?: readonly string[];
  /** Main-toolbar Arrange may explicitly fit or preserve; other layout surfaces stay smart. */
  viewportMode?: PostLayoutViewportMode;
  /** Invocation-order fence reserved before the first asynchronous boundary. */
  viewportIntentToken?: number;
  /** Internal bounded-conflict recovery state; never exposed by UI controls. */
  recovery?: LayoutRecoveryState;
};

export const useBoardObjects = ({
  board,
  client,
  boardObjectsForBoard,
  nodes,
  setNodes,
  deletedObjectsRef,
  eraserMode = false,
  activeUrlTargetArtifactId,
  onEditMarkdown,
  onArrangeNodes,
  onUserLayoutStart,
  onUserLayoutComplete,
  canEdit = true,
}: UseBoardObjectsProps) => {
  // Use ref to avoid recreating callbacks when board changes
  const boardRef = useRef(board);
  boardRef.current = board;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const mutationGate = useMutationGate();
  const canMutateRef = useRef(mutationGate.canMutate);
  canMutateRef.current = mutationGate.canMutate;

  const { showError, showSuccess, showWarning } = useThemedMessage();
  // `handleUpdateObject` re-packs a zone after expanding it, but
  // `arrangeZoneContents` is declared below it and its dependency array is
  // evaluated during render. A ref keeps the call late-bound.
  const arrangeZoneContentsRef = useRef<
    ((zoneId: string, options?: ArrangeZoneContentsOptions) => Promise<void>) | null
  >(null);
  const autoZoneDeferralRef = useRef<AutoZoneDeferral | null>(null);
  autoZoneDeferralRef.current ??= new AutoZoneDeferral();
  const runAutoZoneArrangeRef = useRef<
    (zoneId: string, expectedLease?: AutoZoneObserverLease) => void
  >(() => undefined);
  const lastAutoLayoutSignaturesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const expectedAutoLayoutSignaturesRef = useRef(new Map<string, ExpectedAutoLayoutSignature>());
  const browserLocks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const autoZoneObserverLeaseRef = useRef<AutoZoneObserverLease>({
    boardId: board?.board_id,
    owned: browserLocks === undefined,
  });
  // Revoke the previous board synchronously during render. Waiting for effect
  // cleanup leaves one frame where a route change can use stale React state.
  if (autoZoneObserverLeaseRef.current.boardId !== board?.board_id) {
    autoZoneObserverLeaseRef.current = {
      boardId: board?.board_id,
      owned: browserLocks === undefined,
    };
  }
  const [ownsAutoZoneObserver, setOwnsAutoZoneObserver] = useState(
    () => browserLocks === undefined
  );
  const skipNextAutoArrangeRef = useRef(new Set<string>());
  const preserveNextAutoZoneFrameRef = useRef(new Set<string>());
  // Direct manipulation wins immediately, before the persisted board patch
  // returns over realtime. This also blocks an already-scheduled auto pass
  // from snapping the item back during the interaction.
  const manuallyControlledZoneIdsRef = useRef(new Set<string>());
  const zoneDemotionPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const [zoneStackByNodeId, setZoneStackByNodeId] = useState<
    ReadonlyMap<string, ZoneStackPresentation>
  >(new Map());
  const zoneStackByNodeIdRef = useRef(zoneStackByNodeId);
  zoneStackByNodeIdRef.current = zoneStackByNodeId;
  const [calledOutNodeIds, setCalledOutNodeIds] = useState<ReadonlySet<string>>(new Set());
  const calledOutNodeIdsRef = useRef(calledOutNodeIds);
  calledOutNodeIdsRef.current = calledOutNodeIds;
  const boardArrangementInFlightRef = useRef(false);
  const [isBoardArrangementActive, setIsBoardArrangementActive] = useState(false);
  const layoutIntentEpochRef = useRef(0);
  const boardLayoutGenerationRef = useRef(0);
  const zoneLayoutGenerationRef = useRef(new Map<string, number>());

  const beginZoneLayoutIntent = useCallback((zoneId: string, userInitiated: boolean) => {
    if (userInitiated) layoutIntentEpochRef.current += 1;
    const generation = (zoneLayoutGenerationRef.current.get(zoneId) ?? 0) + 1;
    zoneLayoutGenerationRef.current.set(zoneId, generation);
    return {
      epoch: layoutIntentEpochRef.current,
      scope: 'zone' as const,
      key: zoneId,
      generation,
    };
  }, []);

  const beginBoardLayoutIntent = useCallback(() => {
    layoutIntentEpochRef.current += 1;
    boardLayoutGenerationRef.current += 1;
    return {
      epoch: layoutIntentEpochRef.current,
      scope: 'board' as const,
      key: 'board',
      generation: boardLayoutGenerationRef.current,
    };
  }, []);

  const layoutIntentIsCurrent = useCallback((intent: LayoutIntentToken): boolean => {
    if (intent.epoch !== layoutIntentEpochRef.current) return false;
    return intent.scope === 'board'
      ? intent.generation === boardLayoutGenerationRef.current
      : intent.generation === zoneLayoutGenerationRef.current.get(intent.key);
  }, []);

  /** Direct manipulation supersedes any not-yet-committed layout or stale replan. */
  const cancelPendingLayoutRecovery = useCallback(() => {
    layoutIntentEpochRef.current += 1;
  }, []);

  const acknowledgeExpectedAutoLayouts = useCallback((zoneIds: Iterable<string>) => {
    for (const zoneId of zoneIds) {
      const expected = expectedAutoLayoutSignaturesRef.current.get(zoneId);
      if (!expected) continue;
      expected.acknowledged = true;
      if (lastAutoLayoutSignaturesRef.current.get(zoneId) === expected.signature) {
        expectedAutoLayoutSignaturesRef.current.delete(zoneId);
        autoZoneDeferralRef.current?.cancel(zoneId);
      }
    }
  }, []);

  const clearExpectedAutoLayouts = useCallback((zoneIds: Iterable<string>) => {
    for (const zoneId of zoneIds) {
      expectedAutoLayoutSignaturesRef.current.delete(zoneId);
    }
  }, []);

  // Use the board object's reference directly. The store already preserves
  // unchanged board references, and serializing every object on every canvas
  // render is prohibitively expensive on large boards.
  const boardObjects = board?.objects;

  const completeUserLayout = useCallback(
    (input: {
      userInitiated?: boolean;
      scope: PostLayoutViewportIntent['scope'];
      beforeNodes: readonly Node[];
      afterNodes: readonly Node[];
      affectedNodeIds: readonly string[];
      mode?: PostLayoutViewportMode;
      viewportIntentToken?: number;
    }) => {
      const boardId = boardRef.current?.board_id;
      if (!input.userInitiated || !boardId || !onUserLayoutComplete) return;
      const intent = createPostLayoutViewportIntent({
        source: 'user',
        boardId,
        scope: input.scope,
        mode: input.mode,
        beforeNodes: input.beforeNodes,
        afterNodes: input.afterNodes,
        affectedNodeIds: input.affectedNodeIds,
      });
      if (input.viewportIntentToken === undefined) onUserLayoutComplete(intent);
      else onUserLayoutComplete(intent, input.viewportIntentToken);
    },
    [onUserLayoutComplete]
  );

  useEffect(() => {
    for (const zoneId of manuallyControlledZoneIdsRef.current) {
      const object = boardObjects?.[zoneId];
      if (object?.type === 'zone' && normalizeZoneLayoutPolicy(object.layout).mode === 'manual') {
        manuallyControlledZoneIdsRef.current.delete(zoneId);
        zoneDemotionPromisesRef.current.delete(zoneId);
      }
    }
  }, [boardObjects]);

  useEffect(() => () => autoZoneDeferralRef.current?.dispose(), []);

  useEffect(() => {
    const boardId = board?.board_id;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    layoutIntentEpochRef.current += 1;
    boardLayoutGenerationRef.current = 0;
    zoneLayoutGenerationRef.current.clear();
    lastAutoLayoutSignaturesRef.current = new Map();
    expectedAutoLayoutSignaturesRef.current.clear();
    if (!boardId || !locks) {
      autoZoneObserverLeaseRef.current = { boardId, owned: true };
      setOwnsAutoZoneObserver(true);
      return;
    }

    let active = true;
    const controller = new AbortController();
    const lease: AutoZoneObserverLease = { boardId, owned: false };
    autoZoneObserverLeaseRef.current = lease;
    setOwnsAutoZoneObserver(false);
    void holdAutoZoneObserverLease(
      locks as unknown as AutoZoneObserverLockManager,
      boardId,
      controller.signal,
      (owned) => {
        lease.owned = owned;
        if (active) setOwnsAutoZoneObserver(owned);
      }
    ).catch((error) => {
      if (active) console.error('Failed to coordinate Auto Zone observer ownership:', error);
    });
    return () => {
      lease.owned = false;
      active = false;
      controller.abort();
    };
  }, [board?.board_id]);

  const restoreZoneCallouts = useCallback((zoneId: string) => {
    setCalledOutNodeIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const nodeId of current) {
        if (zoneStackByNodeIdRef.current.get(nodeId)?.zoneId !== zoneId) continue;
        next.delete(nodeId);
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  /** Transient stack interaction keeps Auto Zone armed but postpones its next tidy. */
  const deferAutoZone = useCallback((zoneId: string | null | undefined) => {
    if (!zoneId) return;
    const zone = boardRef.current?.objects?.[zoneId];
    if (zone?.type !== 'zone' || normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto') return;
    const lease = autoZoneObserverLeaseRef.current;
    autoZoneDeferralRef.current?.defer(zoneId, () => runAutoZoneArrangeRef.current(zoneId, lease));
  }, []);

  /** Persist the user's decision to take control of an automatically laid-out zone. */
  const demoteAutoZone = useCallback(
    async (zoneId: string | null | undefined): Promise<boolean> => {
      if (!zoneId || !client) return false;
      const currentBoard = boardRef.current;
      const zone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || zone?.type !== 'zone') return false;
      const layout = normalizeZoneLayoutPolicy(zone.layout);
      if (layout.mode === 'manual') return true;

      const pending = zoneDemotionPromisesRef.current.get(zoneId);
      if (pending) return pending;

      manuallyControlledZoneIdsRef.current.add(zoneId);
      autoZoneDeferralRef.current?.cancel(zoneId);
      expectedAutoLayoutSignaturesRef.current.delete(zoneId);
      skipNextAutoArrangeRef.current.delete(zoneId);
      const demotion = client
        .service('boards')
        .patch(currentBoard.board_id, {
          // mergeObjectFields intentionally accepts zIndex only. Replacing the
          // existing zone through the normal upsert path is what makes this
          // layout-policy transition durable rather than a successful no-op.
          _action: 'upsertObject',
          objectId: zoneId,
          objectData: {
            ...zone,
            layout: { ...layout, mode: 'manual' },
            layout_binding: 'override',
          },
        } as unknown as Partial<Board>)
        .then(() => true)
        .catch((error) => {
          manuallyControlledZoneIdsRef.current.delete(zoneId);
          zoneDemotionPromisesRef.current.delete(zoneId);
          console.error('Failed to disable Auto Zone:', error);
          showError('Failed to disable Auto Zone');
          return false;
        });
      zoneDemotionPromisesRef.current.set(zoneId, demotion);
      return demotion;
    },
    [client, showError]
  );

  /** Change one capable worktree/card's density without allowing auto-layout to undo it. */
  const setPlacementCompact = useCallback(
    async (placement: BoardEntityObject | undefined, compact: boolean, card?: Card) => {
      if (!client || !placement) return;
      const nodeId = placementNodeId(placement);
      const node = nodeId
        ? nodesRef.current.find((candidate) => candidate.id === nodeId)
        : undefined;
      if (!isDensityExpandablePlacement(placement, node, card)) return;
      const stack = nodeId ? zoneStackByNodeIdRef.current.get(nodeId) : undefined;
      if (nodeId && stack && compact && calledOutNodeIdsRef.current.has(nodeId)) {
        setCalledOutNodeIds((current) => {
          const next = new Set(current);
          next.delete(nodeId);
          return next;
        });
        deferAutoZone(stack.zoneId);
        return;
      }
      const transientStackInteraction = !!nodeId && !!stack;
      if (transientStackInteraction) {
        setCalledOutNodeIds((current) => {
          const next = new Set(current);
          if (compact) next.delete(nodeId);
          else next.add(nodeId);
          return next;
        });
        deferAutoZone(stack.zoneId);
        return;
      }
      if ((placement.compact === true) === compact) return;
      if (placement.zone_id && !(await demoteAutoZone(placement.zone_id))) return;
      try {
        await client.service('board-objects').patch(placement.object_id, { compact });
      } catch (error) {
        console.error('Failed to update card density:', error);
        showError('Failed to update card density');
      }
    },
    [client, deferAutoZone, demoteAutoZone, showError]
  );

  /**
   * Collapse or expand every density-capable worktree/card pinned to a zone. This is the UI
   * half of `agor_boards_set_compact` with a `zoneId`: same targeting (pinned
   * entity placements only), same idempotence (placements already at the
   * requested density are skipped rather than re-patched).
   */
  const setZoneContentsCompact = useCallback(
    async (
      zoneId: string,
      compact: boolean,
      options: { silent?: boolean; manualInteraction?: boolean } = {}
    ) => {
      if (!client) return;
      const nodeById = new Map(nodesRef.current.map((node) => [node.id, node]));
      const targets = boardObjectsForBoard.filter((placement) => {
        const nodeId = placementNodeId(placement);
        return (
          placement.zone_id === zoneId &&
          isDensityExpandablePlacement(placement, nodeId ? nodeById.get(nodeId) : undefined) &&
          (placement.compact === true) !== compact
        );
      });
      if (targets.length === 0) return;
      if (options.manualInteraction !== false && !(await demoteAutoZone(zoneId))) return;

      try {
        await Promise.all(
          targets.map((placement) =>
            client.service('board-objects').patch(placement.object_id, { compact })
          )
        );
        // Expanding restores every item's full height while the positions still
        // carry compact_list's one-row spacing, so the items overlap and spill
        // out of the zone. `handleUpdateObject` already re-packs when a *preset*
        // change leaves compact_list, but the zone toolbar calls this directly
        // and never passes through there — so without the same repair here the
        // button reliably produces the broken layout the preset path avoids.
        // Deferred for the same reason as that one: the layout measures
        // rendered nodes, and arranging before the expanded items paint would
        // measure the collapsed heights and pack just as tightly.
        // In compact-list presentation, an arrange deliberately collapses the
        // items again. A manual expand has just demoted the zone specifically
        // so that choice wins, so do not immediately undo it with an explicit
        // compact-list arrange. Grid still needs the measured-height re-pack.
        const zone = boardRef.current?.objects?.[zoneId];
        const shouldRepackExpandedGrid =
          !compact &&
          zone?.type === 'zone' &&
          normalizeZoneLayoutPolicy(zone.layout).preset !== 'compact_list';
        if (shouldRepackExpandedGrid) {
          setTimeout(() => {
            void arrangeZoneContentsRef.current?.(zoneId, { silent: true });
          }, EXPANDED_REPACK_DELAY_MS);
        }
        if (options.silent) return;
        const noun = targets.length === 1 ? 'item' : 'items';
        showSuccess(
          compact ? `Collapsed ${targets.length} ${noun}.` : `Expanded ${targets.length} ${noun}.`
        );
      } catch (error) {
        console.error('Failed to update zone density:', error);
        showError('Failed to update zone density');
      }
    },
    [boardObjectsForBoard, client, demoteAutoZone, showError, showSuccess]
  );

  /**
   * Update an existing board object
   */
  const handleUpdateObject = useCallback(
    async (objectId: string, objectData: BoardObject) => {
      const currentBoard = boardRef.current;
      if (!canEditRef.current || !currentBoard || !client) return false;

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData,
        } as unknown as Partial<Board>);
        return true;
      } catch (error) {
        console.error('Failed to update object:', error);
        showError('Failed to save board object');
        return false;
      }
    },
    [client, showError] // Board and permissions are read through refs, not deps
  );

  /**
   * Reorder a board object relative to its peers (To Front / Bring Forward /
   * Send Backward / To Back). Computes the new zIndex via the pure helper and
   * persists it.
   *
   * Peers are scoped to board objects of the SAME type as the target (zones
   * reorder only against zones). This is intentional: only zones expose reorder
   * controls, so ranking a zone against markdown/app objects — which have no
   * reorder UI — would strand them and let a zone intercept their clicks.
   * Same-type scoping does NOT strictly isolate the per-type default bands:
   * a zone can be pushed above a lower-default markdown (300) / app (400) under
   * deliberate or MCP/import input. The only hard guarantee is the clamp to
   * [1, 499], so a zone can never reach the card (500) / comment (1000) layers.
   *
   * Persistence sends ONLY the changed `zIndex` per object via a narrow field
   * merge (`mergeObjectFields`), not a full stale copy. The server shallow-
   * merges into the freshest stored object and skips any object that was
   * deleted concurrently, so a swap can't resurrect a just-deleted neighbor and
   * unrelated fields edited elsewhere aren't reverted. The merge persists all
   * touched objects in one read-modify-write (last-write-wins vs concurrent
   * writers, like every other board writer — not atomic).
   */
  const reorderObject = useCallback(
    async (objectId: string, op: LayerOp) => {
      const currentBoard = boardRef.current;
      if (!canEditRef.current || !currentBoard || !client) return;

      const objects = currentBoard.objects ?? {};
      const target = objects[objectId];
      if (!target) return;

      const peers = Object.entries(objects)
        .filter(([, obj]) => obj.type === target.type)
        .map(([id, obj]) => ({
          id,
          zIndex: sanitizeZIndex(obj.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX[obj.type]),
        }));

      const changes = computeLayerChanges(op, objectId, peers);
      if (changes.length === 0) return;

      const patches: Record<string, Partial<BoardObject>> = {};
      for (const { id, zIndex } of changes) {
        if (!objects[id]) continue;
        patches[id] = { zIndex };
      }
      if (Object.keys(patches).length === 0) return;

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'mergeObjectFields',
          objects: patches,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to reorder object:', error);
        showError('Failed to reorder zone');
      }
    },
    [client, showError]
  );

  /**
   * Delete a zone (branch-centric: zones can pin branches)
   */
  const deleteZone = useCallback(
    async (objectId: string, _deleteAssociatedSessions: boolean) => {
      if (!canEditRef.current || !board || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal of zone. The SessionCanvas setNodes wrapper clears
      // any orphaned parentId values locally; the daemon owns persistent
      // unpinning and converts zone-relative child positions to absolute.
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(board.board_id, {
          _action: 'deleteZone',
          objectId,
        } as unknown as Partial<Board>);

        // After successful deletion, we can remove from the tracking set
        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete zone:', error);
        // Rollback: remove from deleted set
        deletedObjectsRef.current.delete(objectId);
        // Note: WebSocket update should restore the actual state
      }
    },
    [board, client, setNodes, deletedObjectsRef]
  );

  /**
   * Delete a board object
   */
  const deleteObject = useCallback(
    async (objectId: string) => {
      const currentBoard = boardRef.current;
      if (!canEditRef.current || !currentBoard || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'removeObject',
          objectId,
        } as unknown as Partial<Board>);

        // After successful deletion, we can remove from the tracking set
        // (the object will no longer exist in board.objects)
        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete object:', error);
        // Rollback: remove from deleted set
        deletedObjectsRef.current.delete(objectId);
      }
    },
    [client, setNodes, deletedObjectsRef] // Removed board dependency
  );

  /**
   * Delete an artifact entity (filesystem + board object + DB record).
   * Uses the artifacts service's lifecycle-safe remove method.
   */
  const deleteArtifact = useCallback(
    async (objectId: string, artifactId: string) => {
      // Artifact lifecycle authorization is creator/admin based rather than
      // board.edit based, but it still obeys the global connection/version
      // mutation gate. The ref protects callbacks captured before reconnect.
      if (!canMutateRef.current || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        // Lifecycle-safe: removes filesystem + board object + DB record
        await client.service('artifacts').remove(artifactId);

        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete artifact:', error);
        deletedObjectsRef.current.delete(objectId);
      }
    },
    [client, setNodes, deletedObjectsRef]
  );

  /**
   * Pack every branch/card pinned to a zone using its actual rendered size.
   * Child positions are zone-relative in both React Flow and board_objects, so
   * placements can be applied without translating through canvas coordinates.
   */
  const arrangeZoneContents = useCallback(
    async (zoneId: string, options: ArrangeZoneContentsOptions = {}) => {
      const currentBoard = options.recovery?.source.board ?? boardRef.current;
      const persistedZone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || !client || persistedZone?.type !== 'zone') return;
      const intent =
        options.recovery?.intent ?? beginZoneLayoutIntent(zoneId, options.userInitiated === true);
      if (!options.recovery && options.userInitiated) {
        autoZoneDeferralRef.current?.cancel(zoneId);
      }
      if (
        !layoutIntentIsCurrent(intent) ||
        (options.observerLease &&
          (options.observerLease !== autoZoneObserverLeaseRef.current ||
            !options.observerLease.owned ||
            options.observerLease.boardId !== currentBoard.board_id))
      )
        return;
      const viewportIntentToken =
        options.recovery?.viewportIntentToken ??
        (options.userInitiated ? onUserLayoutStart?.() : undefined);
      const sourceNodes = options.recovery?.source.nodes ?? nodesRef.current;
      const sourcePlacements = options.recovery?.source.placements ?? boardObjectsForBoard;
      const liveZoneNode = sourceNodes.find((node) => node.id === zoneId);
      // A toolbar click can race the debounced persistence of a drag/resize.
      // Plan and write from the visible frame so arranging children can never
      // reintroduce the older container geometry from the board snapshot.
      const visibleWidth = Number(liveZoneNode?.width ?? liveZoneNode?.style?.width);
      const visibleHeight = Number(liveZoneNode?.height ?? liveZoneNode?.style?.height);
      const liveZoneData = liveZoneNode?.data as { fontSize?: number; status?: string } | undefined;
      const zone = {
        ...persistedZone,
        x: liveZoneNode?.position.x ?? persistedZone.x,
        y: liveZoneNode?.position.y ?? persistedZone.y,
        width:
          Number.isFinite(visibleWidth) && visibleWidth > 0 ? visibleWidth : persistedZone.width,
        height:
          Number.isFinite(visibleHeight) && visibleHeight > 0
            ? visibleHeight
            : persistedZone.height,
        fontSize: liveZoneData?.fontSize ?? persistedZone.fontSize,
        status: liveZoneData?.status ?? persistedZone.status,
      };

      let changedNodes: Node[] = [];
      let layoutMode: 'cluster' | 'grid' | 'deck' = 'cluster';
      let overflowCount = 0;

      const policy = normalizeZoneLayoutPolicy(zone.layout);
      const sortItem = (
        node: Node,
        position = node.position
      ): ZoneLayoutSortItem & { node: Node; isCanvasObject: boolean } => {
        const data = node.data as {
          branch?: {
            name?: string;
            created_at?: string;
            updated_at?: string;
            filesystem_status?: string;
          };
          card?: {
            title?: string;
            created_at?: string;
            updated_at?: string;
            data?: Record<string, unknown>;
          };
        };
        const cardData = data.card?.data ?? {};
        return {
          node,
          isCanvasObject: isPositionableZoneCanvasNode(node),
          id: node.id,
          position,
          title:
            data.card?.title ??
            data.branch?.name ??
            (typeof node.data?.title === 'string' ? node.data.title : undefined),
          createdAt: data.card?.created_at ?? data.branch?.created_at,
          updatedAt: data.card?.updated_at ?? data.branch?.updated_at,
          rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
          priority: cardData.priority,
          status: cardData.status ?? data.branch?.filesystem_status,
        };
      };
      const unsortedChildren = nodesRef.current.flatMap((node) => {
        if (node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode')) {
          return [sortItem(node)];
        }
        if (isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, zone)) {
          return [
            sortItem(node, {
              x: node.position.x - zone.x,
              y: node.position.y - zone.y,
            }),
          ];
        }
        return [];
      });
      const children =
        policy.preset === 'grid' && policy.columns === undefined && policy.sortBy === 'position'
          ? unsortedChildren
          : sortZoneLayoutItems(unsortedChildren, policy);
      if (children.length === 0) {
        if (!options.silent) showWarning('This zone has no pinned items to arrange.');
        return;
      }

      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of sourcePlacements) {
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }
      const itemSize = (node: Node) => {
        return canonicalAutoZoneItemSize(
          node,
          placementByNodeId.get(node.id),
          currentBoard.objects?.[node.id],
          options.userInitiated === true
        );
      };
      const fontScale = options.userInitiated ? renderedZoneFontScale(zoneId, zone.width) : 1;
      const frame = getZoneLayoutFrame(zone, {
        // Background Auto Zone writes must be viewport-independent. The
        // screen-stable title occupies a different board-space height at each
        // zoom, so measuring it during an observer pass made two clients (or
        // two reload widths) persist competing child offsets. Explicit layout
        // still plans against the title the initiating user actually sees.
        fontScale,
      });
      const exactGap = policy.gap ?? 24;
      const layoutItems = children.map(({ node, isCanvasObject }) => ({
        id: node.id,
        ...itemSize(node),
        sourceX: isCanvasObject ? node.position.x - zone.x : node.position.x,
        sourceY: isCanvasObject ? node.position.y - zone.y : node.position.y - frame.headerInset,
      }));
      const layoutItemById = new Map(layoutItems.map((item) => [item.id, item]));
      const innerPlan = planBoardZoneArrangement(
        [
          {
            id: zoneId,
            x: zone.x,
            y: zone.y,
            width: zone.width,
            height: zone.height,
            fontSize: zone.fontSize,
            fontScale,
            status: zone.status,
            layout: policy,
            items: children.map(({ node, isCanvasObject }) => {
              const item = layoutItemById.get(node.id);
              if (!item) throw new Error(`Missing measured layout item '${node.id}'.`);
              const sort = sortItem(
                node,
                isCanvasObject
                  ? { x: node.position.x - zone.x, y: node.position.y - zone.y }
                  : node.position
              );
              return {
                ...sort,
                width: item.width,
                height: item.height,
                position: sort.position,
                ...(isCanvasObject
                  ? {}
                  : {
                      entityType:
                        node.type === 'branchNode' ? ('branch' as const) : ('card' as const),
                      densityExpandable: isDensityExpandableNode(node),
                      compact: placementByNodeId.get(node.id)?.compact,
                      expandedSize: expandedDensitySize(node),
                    }),
              };
            }),
          },
        ],
        {
          mode: 'compact',
          startX: zone.x,
          startY: zone.y,
          packZoneContents: true,
          // Explicit Pack is allowed to compact a wasteful manual frame and
          // therefore establishes a new floor. Background Auto Zone passes
          // preserve the current frame but still grow an unsafe one.
          resizeZoneFrames: options.userInitiated === true,
          justifyRows: false,
        }
      );
      const packedZone = innerPlan.zones[0];
      if (!packedZone) throw new Error(`Missing packed zone '${zoneId}'.`);
      const layout = {
        mode:
          policy.preset === 'grid' && policy.columns === undefined
            ? ('cluster' as 'cluster' | 'grid' | 'deck')
            : ('grid' as 'cluster' | 'grid' | 'deck'),
        placements: packedZone.items.map((item) => ({
          ...item,
          y: item.y - frame.headerInset,
        })),
        columns: packedZone.contentColumns,
        rows: new Set(packedZone.items.map((item) => item.row)).size,
        width: packedZone.width,
        height: packedZone.height - frame.headerInset,
        gapX: exactGap,
        gapY: exactGap,
        padding: frame.padding,
        fitsWithoutOverlap: true,
        stackCount: packedZone.items.length,
        maxDeckDepth: 1,
        deckOffsetX: 0,
        deckOffsetY: 0,
        overflowingItemIds: [] as string[],
      };
      const renderedHeaderHeightById = new Map(
        children.flatMap(({ node, isCanvasObject }) => {
          if (isCanvasObject) return [];
          const fallback = compactZoneItemSize(
            node.type === 'branchNode' ? 'branch' : 'card',
            frame.usableWidth
          ).height;
          return [[node.id, renderedZoneStackHeaderHeight(node, fallback)] as const];
        })
      );
      const stackRevealHeight = zoneStackRevealHeight([...renderedHeaderHeightById.values()]);
      if (
        layout.mode === 'deck' &&
        !stackExposesHeaders(layout.placements, renderedHeaderHeightById)
      ) {
        throw new Error('Auto Zone stack would clip a rendered title or action row.');
      }
      layoutMode = layout.mode;
      overflowCount = layout.overflowingItemIds.length;
      if (overflowCount > 0) {
        if (!options.silent) {
          showWarning(
            `This zone cannot fit ${children.length} items without overlap. No positions were changed; enlarge the zone, enable vertical auto-resize, or arrange fewer items.`
          );
        }
        return;
      }
      const placementById = new Map(
        layout.placements.map((placement) => [placement.id, placement])
      );
      setZoneStackByNodeId((current) => {
        const next = new Map(current);
        for (const [nodeId, presentation] of current) {
          if (presentation.zoneId === zoneId) next.delete(nodeId);
        }
        if (layout.mode === 'deck') {
          for (const placement of layout.placements) {
            next.set(placement.id, {
              zoneId,
              stackIndex: placement.stackIndex,
              deckDepth: placement.deckDepth,
              revealHeight: stackRevealHeight,
            });
          }
        }
        if (next.size !== current.size) return next;
        for (const [nodeId, presentation] of next) {
          const previous = current.get(nodeId);
          if (
            !previous ||
            previous.zoneId !== presentation.zoneId ||
            previous.stackIndex !== presentation.stackIndex ||
            previous.deckDepth !== presentation.deckDepth ||
            previous.revealHeight !== presentation.revealHeight
          )
            return next;
        }
        return current;
      });
      if (layout.mode !== 'deck') restoreZoneCallouts(zoneId);
      const titleInset = frame.headerInset;
      const timing = dealTiming({
        count: children.length,
        reducedMotion:
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      });
      // Background Auto Zone maintenance must not impose a temporary measured
      // box on content. React Flow rebuilds entity/canvas nodes from durable
      // state after realtime events; animating a snapped planner box and then
      // restoring the natural DOM box made ResizeObserver alternate forever.
      // Explicit user actions retain the established deal animation.
      const presentPlannedSize = options.userInitiated === true;
      changedNodes = children.map(({ node, isCanvasObject }) => {
        const placement = placementById.get(node.id);
        return placement
          ? {
              ...node,
              className:
                layout.mode === 'deck'
                  ? [node.className, 'auto-zone-stack-item'].filter(Boolean).join(' ')
                  : node.className
                      ?.split(' ')
                      .filter((name) => name !== 'auto-zone-stack-item')
                      .join(' '),
              zIndex: layout.mode === 'deck' ? 500 + placement.deckDepth : node.zIndex,
              ...(presentPlannedSize ? { width: placement.width, height: placement.height } : {}),
              position: isCanvasObject
                ? { x: zone.x + placement.x, y: zone.y + placement.y + titleInset }
                : { x: placement.x, y: placement.y + titleInset },
              data: {
                ...node.data,
                ...(!isCanvasObject && placement.compact !== undefined
                  ? { compact: placement.compact }
                  : {}),
              },
              style: {
                ...node.style,
                ...(layout.mode === 'deck' ? { pointerEvents: 'auto' as const } : {}),
                ...(presentPlannedSize
                  ? {
                      width: placement.width,
                      height: placement.height,
                      ...dealStyle(
                        dealDelayMs(dealOrderIndex(placement, layout.columns), timing),
                        timing
                      ),
                    }
                  : {}),
              },
            }
          : node;
      });
      const visualPositionChanged = changedNodes.some((node) => {
        const current = children.find((child) => child.id === node.id)?.node;
        return (
          !current ||
          Math.abs(current.position.x - node.position.x) >= 0.5 ||
          Math.abs(current.position.y - node.position.y) >= 0.5
        );
      });
      const nextZoneHeight = options.userInitiated
        ? packedZone.height
        : Math.max(zone.height, packedZone.height);
      const nextZoneWidth = options.userInitiated
        ? packedZone.width
        : Math.max(zone.width, packedZone.width);
      const zoneHeightChanged = Math.abs(nextZoneHeight - zone.height) >= 0.5;
      const zoneWidthChanged = Math.abs(nextZoneWidth - zone.width) >= 0.5;
      const membership = getBoardArrangementCandidates(currentBoard, sourceNodes);
      const sourceZones = sourceNodes.flatMap((node) => {
        if (
          node.hidden ||
          node.parentId ||
          (!BOARD_ARRANGEABLE_NODE_TYPES.has(node.type ?? '') && node.type !== 'zone') ||
          membership.zoneForCanvasNode.has(node.id)
        )
          return [];
        const size = ceilBoardGridSize(renderedNodeSize(node));
        const boardObject = currentBoard.objects?.[node.id];
        return [
          {
            id: node.id,
            ...node.position,
            ...size,
            locked:
              node.data?.locked === true ||
              (boardObject && 'locked' in boardObject && boardObject.locked === true),
          },
        ];
      });
      const reflowPlan =
        (policy.mode === 'auto' || policy.onOverflow === 'reflow_board') &&
        (zoneHeightChanged || zoneWidthChanged)
          ? planZoneGrowthReflow(
              sourceZones,
              zoneId,
              {
                id: zoneId,
                x: zone.x,
                y: zone.y,
                width: nextZoneWidth,
                height: nextZoneHeight,
              },
              { gap: policy.gap }
            )
          : null;
      const movedZoneIds = new Set(reflowPlan?.movedZoneIds ?? []);
      const movedPlacementById = new Map(
        reflowPlan?.placements
          .filter((item) => movedZoneIds.has(item.id))
          .map((item) => [item.id, item]) ?? []
      );
      const grownRootPlacement = movedPlacementById.get(zoneId);
      const zoneRootIds = new Set(
        sourceNodes.filter((node) => node.type === 'zone').map((node) => node.id)
      );
      const reflowedNodes = sourceNodes.flatMap((node) => {
        const movedZone = movedPlacementById.get(node.id);
        if (movedZone) {
          return [{ ...node, position: { x: movedZone.x, y: movedZone.y } }];
        }
        if (!isPositionableZoneCanvasNode(node)) return [];
        const sourceZone = sourceZones
          .filter(
            (candidate) =>
              zoneRootIds.has(candidate.id) &&
              movedZoneIds.has(candidate.id) &&
              nodeCenterInsideZone(node, candidate)
          )
          .sort(
            (left, right) =>
              left.width * left.height - right.width * right.height ||
              left.id.localeCompare(right.id)
          )[0];
        const placement = sourceZone ? movedPlacementById.get(sourceZone.id) : undefined;
        if (!sourceZone || !placement) return [];
        const packedNode = changedNodes.find((candidate) => candidate.id === node.id) ?? node;
        return [
          {
            ...packedNode,
            position: {
              x: packedNode.position.x + placement.x - sourceZone.x,
              y: packedNode.position.y + placement.y - sourceZone.y,
            },
          },
        ];
      });

      // Compare planner output with durable geometry, not React Flow's
      // approximate node props. The latter intentionally differ from measured
      // cards/worktrees and are rebuilt after every board realtime event; using
      // them made an already-persisted layout look changed forever.
      const durableEntityGeometryChanged = children.some(({ node, isCanvasObject }) => {
        if (isCanvasObject) return false;
        const durable = placementByNodeId.get(node.id);
        const arranged = placementById.get(node.id);
        if (!durable || !arranged) return false;
        if (!durable.position) return true;
        return (
          Math.abs(durable.position.x - arranged.x) >= 0.5 ||
          Math.abs(durable.position.y - (arranged.y + titleInset)) >= 0.5 ||
          !durable.size ||
          Math.abs(durable.size.width - arranged.width) >= 0.5 ||
          Math.abs(durable.size.height - arranged.height) >= 0.5
        );
      });
      const durableCanvasGeometryChanged = children.some(({ node, isCanvasObject }) => {
        if (!isCanvasObject) return false;
        const durable = currentBoard.objects?.[node.id];
        const arrangedNode = changedNodes.find((candidate) => candidate.id === node.id);
        const arranged = placementById.get(node.id);
        if (!durable || !arrangedNode || !arranged) return false;
        return (
          Math.abs(durable.x - arrangedNode.position.x) >= 0.5 ||
          Math.abs(durable.y - arrangedNode.position.y) >= 0.5 ||
          ('width' in durable && Math.abs(Number(durable.width) - arranged.width) >= 0.5) ||
          ('height' in durable && Math.abs(Number(durable.height) - arranged.height) >= 0.5)
        );
      });

      const compactChanged = children.some(({ node, isCanvasObject }) => {
        if (isCanvasObject) return false;
        const durable = placementByNodeId.get(node.id);
        const arranged = placementById.get(node.id);
        return (
          durable !== undefined &&
          arranged?.compact !== undefined &&
          (durable.compact === true) !== arranged.compact
        );
      });
      if (
        !visualPositionChanged &&
        !durableEntityGeometryChanged &&
        !durableCanvasGeometryChanged &&
        !zoneHeightChanged &&
        !zoneWidthChanged &&
        !compactChanged
      )
        return;
      const changedById = new Map(changedNodes.map((node) => [node.id, node]));
      const reflowedById = new Map(reflowedNodes.map((node) => [node.id, node]));
      const grownZoneNode = sourceNodes.find((node) => node.id === zoneId);
      const optimisticZone =
        grownZoneNode && (zoneHeightChanged || zoneWidthChanged)
          ? {
              ...grownZoneNode,
              position: grownRootPlacement
                ? { x: grownRootPlacement.x, y: grownRootPlacement.y }
                : grownZoneNode.position,
              width: nextZoneWidth,
              height: nextZoneHeight,
              style: { ...grownZoneNode.style, width: nextZoneWidth, height: nextZoneHeight },
              data: { ...grownZoneNode.data, width: nextZoneWidth, height: nextZoneHeight },
            }
          : undefined;
      const optimisticNodes = [
        ...changedNodes,
        ...reflowedNodes,
        ...(optimisticZone ? [optimisticZone] : []),
      ];
      const optimisticById = new Map(optimisticNodes.map((node) => [node.id, node]));
      const finalNodes = sourceNodes.map((node) => optimisticById.get(node.id) ?? node);
      const targetObserverSignature = autoZoneObserverSignature({
        zoneId,
        width: nextZoneWidth,
        height: nextZoneHeight,
        layout: zone.layout,
        children: children.flatMap(({ node }) => {
          const arrangedNode = reflowedById.get(node.id) ?? changedById.get(node.id);
          const arranged = placementById.get(node.id);
          if (!arrangedNode || !arranged) return [];
          return [
            {
              id: node.id,
              x: arrangedNode.position.x,
              y: arrangedNode.position.y,
              width: arranged.width,
              height: arranged.height,
              sortData: autoZoneObserverSortData(node),
            },
          ];
        }),
      });
      let expectedLayoutRegistered = false;
      if (policy.mode === 'auto') {
        // Match the exact normalized post-write target rather than blindly
        // consuming one observer pass. Optimistic state, durable selectors,
        // and realtime compatibility events can arrive in several renders.
        expectedAutoLayoutSignaturesRef.current.set(zoneId, {
          signature: targetObserverSignature,
          acknowledged: false,
        });
        expectedLayoutRegistered = true;
        skipNextAutoArrangeRef.current.delete(zoneId);
      }
      try {
        const canvasObjects = Object.fromEntries(
          children.flatMap(({ node, isCanvasObject }) => {
            if (!isCanvasObject) return [];
            const arrangedNode = reflowedById.get(node.id) ?? changedById.get(node.id);
            const arranged = placementById.get(node.id);
            const existing = currentBoard.objects?.[node.id];
            if (!arrangedNode || !arranged || !existing) return [];
            const next = {
              ...existing,
              x: arrangedNode.position.x,
              y: arrangedNode.position.y,
              ...('width' in existing ? { width: arranged.width } : {}),
              ...('height' in existing ? { height: arranged.height } : {}),
            } as BoardObject;
            return [[node.id, next] as const];
          })
        );
        const reflowedEntries: Array<readonly [string, BoardObject]> = [];
        for (const node of reflowedNodes) {
          if (node.id === zoneId) continue;
          const existing = currentBoard.objects?.[node.id];
          if (existing) {
            reflowedEntries.push([
              node.id,
              { ...existing, x: node.position.x, y: node.position.y } as BoardObject,
            ]);
          }
        }
        const reflowedObjects = Object.fromEntries(reflowedEntries);
        const objects = {
          [zoneId]: {
            ...zone,
            x: grownRootPlacement?.x ?? zone.x,
            y: grownRootPlacement?.y ?? zone.y,
            width: nextZoneWidth,
            height: nextZoneHeight,
          },
          ...reflowedObjects,
          ...canvasObjects,
        };
        const placements = Object.fromEntries(
          [...changedNodes, ...reflowedNodes].flatMap((node) => {
            const placement = placementByNodeId.get(node.id);
            if (!placement) return [];
            const arranged = placementById.get(node.id);
            const { width, height } = arranged ?? ceilBoardGridSize(renderedNodeSize(node));
            const targetCompact = arranged?.compact;
            const densityChanged =
              targetCompact !== undefined && (placement.compact === true) !== targetCompact;
            return [
              [
                placement.object_id,
                {
                  // applyLayout's placement contract is a complete geometry
                  // snapshot. Supplying only the changed half would serialize
                  // the other required field as undefined in the repository.
                  position: node.position,
                  size: { width, height },
                  ...(densityChanged ? { compact: targetCompact } : {}),
                },
              ] as const,
            ];
          })
        );
        if (Object.keys(objects).length > 0 || Object.keys(placements).length > 0) {
          // Canvas objects, the zone frame, and entity placements form one
          // geometry snapshot. Publishing the existing atomic layout action
          // prevents partial placement echoes from re-arming the observer.
          if (
            !layoutIntentIsCurrent(intent) ||
            (options.observerLease &&
              (options.observerLease !== autoZoneObserverLeaseRef.current ||
                !options.observerLease.owned ||
                options.observerLease.boardId !== currentBoard.board_id))
          ) {
            if (expectedLayoutRegistered) clearExpectedAutoLayouts([zoneId]);
            return;
          }
          const batch: BoardLayoutBatch = {
            objects,
            placements,
            expected: expectedLayoutSnapshot(
              currentBoard,
              new Map(sourcePlacements.map((placement) => [placement.object_id, placement]))
            ),
          };
          const result = (await client.service('boards').patch(currentBoard.board_id, {
            _action: 'applyLayout',
            ...batch,
          } as unknown as Partial<Board>)) as unknown as BoardLayoutApplyResult;
          if (!layoutResultCoversBatch(result, batch)) {
            throw new Error('Board layout acknowledgement omitted committed geometry');
          }
          if (expectedLayoutRegistered) acknowledgeExpectedAutoLayouts([zoneId]);
        } else if (expectedLayoutRegistered) {
          clearExpectedAutoLayouts([zoneId]);
        }
        if (!layoutIntentIsCurrent(intent)) return;
        if (optimisticNodes.length > 0) {
          onArrangeNodes?.(optimisticNodes, timing.totalMs);
          setNodes((currentNodes) =>
            currentNodes.map((node) => {
              if (node.id === zoneId && (zoneHeightChanged || zoneWidthChanged)) {
                return optimisticZone ?? node;
              }
              return reflowedById.get(node.id) ?? changedById.get(node.id) ?? node;
            })
          );
        }
        if (overflowCount > 0 && !options.silent) {
          showWarning(
            `Arranged ${changedNodes.length} items, but ${overflowCount} cannot fit inside this zone.`
          );
        } else if (layoutMode === 'deck' && !options.silent) {
          showWarning(
            `The Auto Zone is full. Stacked ${changedNodes.length} collapsed items with every title and action row exposed.`
          );
        } else if (!options.silent) {
          showSuccess(
            `Arranged ${changedNodes.length} items in a non-overlapping ${layoutMode === 'cluster' ? 'compact cluster' : 'grid'}.`
          );
        }
        completeUserLayout({
          userInitiated: options.userInitiated,
          viewportIntentToken,
          scope: 'zone',
          beforeNodes: sourceNodes,
          afterNodes: finalNodes,
          affectedNodeIds: [
            zoneId,
            ...children.map(({ node }) => node.id),
            ...reflowedNodes.map((node) => node.id),
          ],
        });
      } catch (error) {
        if (expectedLayoutRegistered) clearExpectedAutoLayouts([zoneId]);
        if (isBoardLayoutSnapshotStale(error)) {
          const attempt = options.recovery?.attempt ?? 0;
          if (!layoutIntentIsCurrent(intent)) return;
          if (attempt < MAX_LAYOUT_STALE_REPLANS) {
            try {
              const source = await fetchAuthoritativeLayoutSource(
                client,
                currentBoard.board_id,
                nodesRef.current
              );
              if (!source || !layoutIntentIsCurrent(intent)) {
                if (options.userInitiated && layoutIntentIsCurrent(intent)) {
                  showError(
                    'The board changed while arranging. Try again after it finishes loading.'
                  );
                }
                return;
              }
              await arrangeZoneContentsRef.current?.(zoneId, {
                ...options,
                recovery: {
                  attempt: attempt + 1,
                  intent,
                  source,
                  viewportIntentToken,
                },
              });
            } catch (refreshError) {
              console.error('Failed to refresh current board layout:', refreshError);
              if (options.userInitiated) showError('Failed to refresh the current board layout');
            }
            return;
          }
          // A second conflict means another writer won again. Background
          // maintenance stops silently; explicit intent gets one actionable
          // message and never enters an observer/toast loop.
          if (options.userInitiated) {
            showError('The board changed again while arranging. Try again.');
          }
          return;
        }
        console.error('Failed to arrange zone contents:', error);
        showError('Failed to arrange zone contents');
      }
    },
    [
      acknowledgeExpectedAutoLayouts,
      beginZoneLayoutIntent,
      boardObjectsForBoard,
      clearExpectedAutoLayouts,
      client,
      completeUserLayout,
      layoutIntentIsCurrent,
      onUserLayoutStart,
      onArrangeNodes,
      restoreZoneCallouts,
      setNodes,
      showError,
      showSuccess,
      showWarning,
    ]
  );
  arrangeZoneContentsRef.current = arrangeZoneContents;

  /**
   * Align a zone's visible heterogeneous rows or columns independently. This
   * is deliberately a one-shot direct edit: an armed Auto Zone is demoted
   * before the optimistic position change, so no pending observer can re-pack
   * it.
   */
  const justifyZoneContents = useCallback(
    async (zoneId: string, justification: ZoneContentJustification) => {
      const currentBoard = boardRef.current;
      const persistedZone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || !client || persistedZone?.type !== 'zone') return;
      const currentNodes = nodesRef.current;
      const liveZoneNode = currentNodes.find((node) => node.id === zoneId);
      const visibleWidth = Number(liveZoneNode?.width ?? liveZoneNode?.style?.width);
      const visibleHeight = Number(liveZoneNode?.height ?? liveZoneNode?.style?.height);
      const liveZoneData = liveZoneNode?.data as { fontSize?: number; status?: string } | undefined;
      const zone = {
        ...persistedZone,
        x: liveZoneNode?.position.x ?? persistedZone.x,
        y: liveZoneNode?.position.y ?? persistedZone.y,
        width:
          Number.isFinite(visibleWidth) && visibleWidth > 0 ? visibleWidth : persistedZone.width,
        height:
          Number.isFinite(visibleHeight) && visibleHeight > 0
            ? visibleHeight
            : persistedZone.height,
        fontSize: liveZoneData?.fontSize ?? persistedZone.fontSize,
        status: liveZoneData?.status ?? persistedZone.status,
      };
      const policy = normalizeZoneLayoutPolicy(zone.layout);
      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of boardObjectsForBoard) {
        if (placement.zone_id !== zoneId) continue;
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }
      const children = currentNodes.flatMap((node) => {
        const isPinnedEntity =
          node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode');
        const isCanvasObject =
          isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, zone);
        if (!isPinnedEntity && !isCanvasObject) return [];
        return [
          {
            node,
            isCanvasObject,
            rect: {
              id: node.id,
              x: isCanvasObject ? node.position.x - zone.x : node.position.x,
              y: isCanvasObject ? node.position.y - zone.y : node.position.y,
              ...ceilBoardGridSize(renderedNodeSize(node)),
            },
          },
        ];
      });
      if (children.length === 0) {
        showWarning('This zone has no contents to justify.');
        return;
      }

      const alignmentChildren =
        policy.preset === 'grid' && (policy.columns ?? 0) > 1
          ? [...children].sort(
              (left, right) =>
                left.rect.y - right.rect.y ||
                left.rect.x - right.rect.x ||
                left.rect.id.localeCompare(right.rect.id)
            )
          : children;
      const justified = justifyZoneContentCluster(
        alignmentChildren.map(({ rect }) => rect),
        getZoneLayoutFrame(zone, {
          fontScale: renderedZoneFontScale(zoneId, zone.width),
        }),
        zone.height,
        justification,
        policy.preset === 'grid' && (policy.columns ?? 0) > 1
          ? { columns: policy.columns ?? 1, gap: policy.gap ?? 24 }
          : undefined
      );
      if (!justified.fits) {
        showWarning('The contents do not fit on that axis. Resize or tidy the zone first.');
        return;
      }
      const placementById = new Map(justified.placements.map((item) => [item.id, item]));
      const changedNodes = children.flatMap(({ node, isCanvasObject }) => {
        const placement = placementById.get(node.id);
        if (!placement) return [];
        const position = isCanvasObject
          ? { x: zone.x + placement.x, y: zone.y + placement.y }
          : { x: placement.x, y: placement.y };
        if (
          Math.abs(position.x - node.position.x) < 0.5 &&
          Math.abs(position.y - node.position.y) < 0.5
        )
          return [];
        return [{ ...node, position }];
      });
      const label =
        justification === 'middle'
          ? 'center'
          : justification === 'vertical_middle'
            ? 'vertical center'
            : justification;
      if (changedNodes.length === 0) {
        showSuccess(
          justification === 'middle'
            ? 'Contents are already centered in the zone.'
            : justification === 'vertical_middle'
              ? 'Contents are already centered vertically in the zone.'
              : `Contents are already justified to the ${label}.`
        );
        return;
      }
      const viewportIntentToken = onUserLayoutStart?.();
      const demotingAutoZone = policy.mode === 'auto';
      if (demotingAutoZone) {
        manuallyControlledZoneIdsRef.current.add(zoneId);
        autoZoneDeferralRef.current?.cancel(zoneId);
        expectedAutoLayoutSignaturesRef.current.delete(zoneId);
        skipNextAutoArrangeRef.current.delete(zoneId);
      }

      const changedById = new Map(changedNodes.map((node) => [node.id, node]));
      onArrangeNodes?.(changedNodes, 180);
      setNodes((nodes) => nodes.map((node) => changedById.get(node.id) ?? node));

      try {
        const canvasObjects = Object.fromEntries(
          children.flatMap(({ node, isCanvasObject }) => {
            if (!isCanvasObject) return [];
            const changed = changedById.get(node.id);
            const existing = currentBoard.objects?.[node.id];
            if (!changed || !existing) return [];
            return [
              [node.id, { ...existing, x: changed.position.x, y: changed.position.y }] as const,
            ];
          })
        );
        const objects = {
          ...(demotingAutoZone
            ? {
                [zoneId]: {
                  ...persistedZone,
                  layout: { ...policy, mode: 'manual' as const },
                  layout_binding: 'override' as const,
                },
              }
            : {}),
          ...canvasObjects,
        };
        const placements = Object.fromEntries(
          changedNodes.flatMap((node) => {
            const placement = placementByNodeId.get(node.id);
            if (!placement) return [];
            return [
              [
                placement.object_id,
                {
                  position: node.position,
                  size: ceilBoardGridSize(renderedNodeSize(node)),
                },
              ] as const,
            ];
          })
        );
        const batch: BoardLayoutBatch = {
          objects,
          placements,
          expected: expectedLayoutSnapshot(
            currentBoard,
            new Map(boardObjectsForBoard.map((placement) => [placement.object_id, placement]))
          ),
        };
        const result = (await client.service('boards').patch(currentBoard.board_id, {
          _action: 'applyLayout',
          ...batch,
        } as unknown as Partial<Board>)) as unknown as BoardLayoutApplyResult;
        if (!layoutResultCoversBatch(result, batch)) {
          throw new Error('Board layout acknowledgement omitted committed geometry');
        }
        completeUserLayout({
          userInitiated: true,
          viewportIntentToken,
          scope: 'zone',
          beforeNodes: currentNodes,
          afterNodes: currentNodes.map((node) => changedById.get(node.id) ?? node),
          affectedNodeIds: [zoneId, ...children.map(({ node }) => node.id)],
        });
        showSuccess(
          justification === 'vertical_middle'
            ? `Centered ${changedNodes.length} items vertically in the zone.`
            : `Justified ${changedNodes.length} items to the ${label}.`
        );
      } catch (error) {
        if (demotingAutoZone) manuallyControlledZoneIdsRef.current.delete(zoneId);
        console.error('Failed to justify zone contents:', error);
        showError('Failed to justify zone contents');
      }
    },
    [
      boardObjectsForBoard,
      client,
      completeUserLayout,
      onArrangeNodes,
      onUserLayoutStart,
      setNodes,
      showError,
      showSuccess,
      showWarning,
    ]
  );

  /** Keep an explicitly dragged/resized Auto Zone frame while its children re-pack. */
  const preserveAutoZoneFrameOnce = useCallback(
    (zoneId: string) => {
      const zone = boardRef.current?.objects?.[zoneId];
      if (zone?.type !== 'zone' || normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto') return;
      cancelPendingLayoutRecovery();
      clearExpectedAutoLayouts([zoneId]);
      preserveNextAutoZoneFrameRef.current.add(zoneId);
      const lease = autoZoneObserverLeaseRef.current;
      autoZoneDeferralRef.current?.defer(zoneId, () =>
        runAutoZoneArrangeRef.current(zoneId, lease)
      );
    },
    [cancelPendingLayoutRecovery, clearExpectedAutoLayouts]
  );

  /**
   * Arrange selected zone containers and their measured children using the
   * same pure planner as agor_boards_arrange_zones. Zone containers are one
   * board mutation, so realtime cannot echo intermediate board snapshots.
   */
  const arrangeBoardZones = useCallback(
    async (zoneIds: readonly string[], options: ArrangeBoardZonesOptions = {}) => {
      const {
        userInitiated = false,
        layoutScope = 'board',
        selectedRootIds,
        viewportMode = 'smart',
        viewportIntentToken: suppliedViewportIntentToken,
        recovery,
        ...arrangementOptions
      } = options;
      const currentBoard = recovery?.source.board ?? boardRef.current;
      const ownsInFlight = !recovery;
      if (!currentBoard || !client || (ownsInFlight && boardArrangementInFlightRef.current)) return;
      const intent = recovery?.intent ?? beginBoardLayoutIntent();
      if (!layoutIntentIsCurrent(intent)) return;
      const viewportIntentToken =
        recovery?.viewportIntentToken ??
        (userInitiated ? (suppliedViewportIntentToken ?? onUserLayoutStart?.()) : undefined);
      const selected = new Set(zoneIds);
      const currentNodes = recovery?.source.nodes ?? nodesRef.current;
      const sourcePlacements = recovery?.source.placements ?? boardObjectsForBoard;
      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of sourcePlacements) {
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }

      if (ownsInFlight) {
        boardArrangementInFlightRef.current = true;
        setIsBoardArrangementActive(true);
      }
      const explicitExpectationZoneIds = new Set<string>();
      try {
        const candidates = getBoardArrangementCandidates(
          currentBoard,
          currentNodes,
          selected,
          selectedRootIds ? new Set(selectedRootIds) : undefined
        );
        // One canonical board-space title inset keeps UI, MCP, whole-board,
        // selection, and the post-fit repeat on identical geometry.
        const selectedZones = candidates.selectedZones.map(
          ([zoneId, object]) => [zoneId, { ...object, fontScale: 1 }] as const
        );
        const { zoneForCanvasNode, looseNodes, fixedObstacles } = candidates;
        const scopedArrangementOptions =
          layoutScope === 'selection'
            ? {
                ...arrangementOptions,
                anchorToSelectionBounds: true,
                fixedObstacles,
              }
            : {
                ...arrangementOptions,
                // Locked/otherwise ineligible visible roots stay fixed and
                // constrain a whole-board plan just as unselected peers do.
                fixedObstacles,
              };
        const plan = planBoardZoneArrangement(
          selectedZones.map(([zoneId, object]) => {
            const persistedZone = currentBoard.objects?.[zoneId];
            const children = currentNodes.filter((node) => {
              if (
                node.parentId === zoneId &&
                !node.hidden &&
                node.data?.locked !== true &&
                (node.type === 'branchNode' || node.type === 'cardNode')
              )
                return true;
              return (
                isPositionableZoneCanvasNode(node) && zoneForCanvasNode.get(node.id) === zoneId
              );
            });
            return {
              id: zoneId,
              x: object.x,
              y: object.y,
              width: object.width,
              height: object.height,
              fontSize: object.fontSize,
              fontScale: object.fontScale,
              status: object.status,
              layout: object.layout,
              resizable: true,
              minWidth: persistedZone?.type === 'zone' ? persistedZone.width : object.width,
              minHeight: persistedZone?.type === 'zone' ? persistedZone.height : object.height,
              items: children.map((node) => {
                const isCanvasObject = isPositionableZoneCanvasNode(node);
                const data = node.data as {
                  branch?: {
                    name?: string;
                    created_at?: string;
                    updated_at?: string;
                    filesystem_status?: string;
                  };
                  card?: {
                    title?: string;
                    created_at?: string;
                    updated_at?: string;
                    data?: Record<string, unknown>;
                  };
                };
                const cardData = data.card?.data ?? {};
                const placement = placementByNodeId.get(node.id);
                return {
                  id: node.id,
                  ...(isCanvasObject
                    ? {}
                    : {
                        entityType:
                          node.type === 'branchNode' ? ('branch' as const) : ('card' as const),
                        densityExpandable: isDensityExpandableNode(node),
                        expandedSize: expandedDensitySize(node),
                      }),
                  position: isCanvasObject
                    ? { x: node.position.x - object.x, y: node.position.y - object.y }
                    : node.position,
                  compact: placement?.compact,
                  ...ceilBoardGridSize(renderedNodeSize(node)),
                  title: data.card?.title ?? data.branch?.name,
                  createdAt: data.card?.created_at ?? data.branch?.created_at,
                  updatedAt: data.card?.updated_at ?? data.branch?.updated_at,
                  rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
                  priority: cardData.priority,
                  status: cardData.status ?? data.branch?.filesystem_status,
                };
              }),
            };
          }),
          {
            ...scopedArrangementOptions,
            looseItems: (layoutScope === 'board' || selectedRootIds ? looseNodes : []).map(
              (node) => {
                const placement = placementByNodeId.get(node.id);
                const isEntity = node.type === 'branchNode' || node.type === 'cardNode';
                const rendered = ceilBoardGridSize(renderedNodeSize(node));
                const canvasObject = currentBoard.objects?.[node.id];
                const persistedWidth =
                  (canvasObject && 'width' in canvasObject ? canvasObject.width : undefined) ??
                  placement?.size?.width ??
                  rendered.width;
                const persistedHeight =
                  (canvasObject && 'height' in canvasObject ? canvasObject.height : undefined) ??
                  placement?.size?.height ??
                  rendered.height;
                return {
                  id: node.id,
                  ...node.position,
                  ...rendered,
                  minWidth: persistedWidth,
                  minHeight: persistedHeight,
                  resizable: node.data?.locked !== true,
                  ...(isEntity
                    ? {
                        entityType:
                          node.type === 'branchNode' ? ('branch' as const) : ('card' as const),
                        compact: placement?.compact,
                        densityExpandable: isDensityExpandableNode(node),
                        expandedSize: expandedDensitySize(node),
                      }
                    : {}),
                };
              }
            ),
          }
        );
        const arrangedZoneById = new Map(plan.zones.map((zone) => [zone.id, zone]));
        const arrangedCanvasChildren = plan.zones.flatMap((zone) =>
          zone.items.flatMap((item) =>
            currentBoard.objects?.[item.id]
              ? [
                  {
                    ...item,
                    x: zone.position.x + item.x,
                    y: zone.position.y + item.y,
                  },
                ]
              : []
          )
        );
        const arrangedItemById = new Map(
          [
            ...plan.zones.flatMap((zone) =>
              zone.items.filter((item) => !currentBoard.objects?.[item.id])
            ),
            ...arrangedCanvasChildren,
            ...plan.looseItems,
          ].map((item) => [item.id, item] as const)
        );
        const arrangedNodes = currentNodes.flatMap((node) => {
          const zone = arrangedZoneById.get(node.id);
          if (zone) {
            autoZoneDeferralRef.current?.cancel(node.id);
            restoreZoneCallouts(node.id);
            return [
              {
                ...node,
                position: zone.position,
                width: zone.width,
                height: zone.height,
                style: { ...node.style, width: zone.width, height: zone.height },
                data: { ...node.data, width: zone.width, height: zone.height },
              },
            ];
          }
          const item = arrangedItemById.get(node.id);
          if (!item) return [];
          return [
            {
              ...node,
              className: node.className
                ?.split(' ')
                .filter((name) => name !== 'auto-zone-stack-item')
                .join(' '),
              position: { x: item.x, y: item.y },
              width: item.width,
              height: item.height,
              style: { ...node.style, width: item.width, height: item.height },
              data: {
                ...node.data,
                ...(item.compact === undefined ? {} : { compact: item.compact }),
              },
            },
          ];
        });
        const geometryChanged = arrangedNodes.some((next) => {
          const current = currentNodes.find((node) => node.id === next.id);
          if (!current) return true;
          const currentSize = renderedNodeSize(current);
          const nextSize = renderedNodeSize(next);
          return (
            Math.abs(current.position.x - next.position.x) >= 0.5 ||
            Math.abs(current.position.y - next.position.y) >= 0.5 ||
            Math.abs(currentSize.width - nextSize.width) >= 0.5 ||
            Math.abs(currentSize.height - nextSize.height) >= 0.5
          );
        });
        const densityChanged = [
          ...plan.zones.flatMap((zone) => zone.items),
          ...plan.looseItems,
        ].some((item) => {
          const placement = placementByNodeId.get(item.id);
          return (
            placement !== undefined &&
            item.compact !== undefined &&
            (placement.compact === true) !== item.compact
          );
        });
        const arrangedNodeById = new Map(arrangedNodes.map((node) => [node.id, node]));
        const afterNodes = currentNodes.map((node) => arrangedNodeById.get(node.id) ?? node);
        const affectedNodeIds =
          layoutScope === 'board' && viewportMode !== 'smart'
            ? [
                ...new Set([
                  ...arrangedNodes.map((node) => node.id),
                  ...fixedObstacles.map((node) => node.id),
                ]),
              ]
            : arrangedNodes.map((node) => node.id);
        if (!geometryChanged && !densityChanged) {
          if (viewportMode !== 'smart') {
            completeUserLayout({
              userInitiated,
              viewportIntentToken,
              scope: layoutScope,
              mode: viewportMode,
              beforeNodes: currentNodes,
              afterNodes,
              affectedNodeIds,
            });
          }
          showSuccess('Zones and their contents are already arranged.');
          return;
        }
        for (const arrangedZone of plan.zones) {
          const zoneObject = currentBoard.objects?.[arrangedZone.id];
          if (
            zoneObject?.type !== 'zone' ||
            normalizeZoneLayoutPolicy(zoneObject.layout).mode !== 'auto'
          )
            continue;
          const signature = autoZoneObserverSignature({
            zoneId: arrangedZone.id,
            width: arrangedZone.width,
            height: arrangedZone.height,
            layout: zoneObject.layout,
            children: arrangedZone.items.flatMap((item) => {
              const sourceNode = currentNodes.find((node) => node.id === item.id);
              if (!sourceNode) return [];
              const isCanvasObject = Boolean(currentBoard.objects?.[item.id]);
              return [
                {
                  id: item.id,
                  x: isCanvasObject ? arrangedZone.position.x + item.x : item.x,
                  y: isCanvasObject ? arrangedZone.position.y + item.y : item.y,
                  width: item.width,
                  height: item.height,
                  sortData: autoZoneObserverSortData(sourceNode),
                },
              ];
            }),
          });
          expectedAutoLayoutSignaturesRef.current.set(arrangedZone.id, {
            signature,
            acknowledged: false,
          });
          explicitExpectationZoneIds.add(arrangedZone.id);
          skipNextAutoArrangeRef.current.delete(arrangedZone.id);
        }
        const plannedObjects = Object.fromEntries([
          ...plan.zones.map((zone) => {
            const existing = currentBoard.objects?.[zone.id];
            if (existing?.type !== 'zone') {
              throw new Error(`Missing board zone '${zone.id}'.`);
            }
            return [
              zone.id,
              {
                ...existing,
                x: zone.position.x,
                y: zone.position.y,
                width: zone.width,
                height: zone.height,
              },
            ];
          }),
          ...plan.looseItems.flatMap((item) => {
            const existing = currentBoard.objects?.[item.id];
            if (!existing) return [];
            return [
              [
                item.id,
                {
                  ...existing,
                  x: item.x,
                  y: item.y,
                  ...('width' in existing ? { width: item.width } : {}),
                  ...('height' in existing ? { height: item.height } : {}),
                },
              ] as const,
            ];
          }),
          ...arrangedCanvasChildren.flatMap((item) => {
            const existing = currentBoard.objects?.[item.id];
            if (!existing) return [];
            return [
              [
                item.id,
                {
                  ...existing,
                  x: item.x,
                  y: item.y,
                  ...('width' in existing ? { width: item.width } : {}),
                  ...('height' in existing ? { height: item.height } : {}),
                },
              ] as const,
            ];
          }),
        ]);
        const objects = plannedObjects;
        const plannedPlacements = Object.fromEntries(
          [
            ...plan.zones.flatMap((zone) => zone.items.map((item) => ({ item }))),
            ...plan.looseItems.map((item) => ({ item })),
          ].flatMap(({ item }) => {
            const placement = placementByNodeId.get(item.id);
            if (!placement) return [];
            return [
              [
                placement.object_id,
                {
                  position: { x: item.x, y: item.y },
                  size: { width: item.width, height: item.height },
                  ...(item.compact !== undefined && (placement.compact === true) !== item.compact
                    ? { compact: item.compact }
                    : {}),
                },
              ] as const,
            ];
          })
        );
        const placements = plannedPlacements;
        const batch: BoardLayoutBatch = {
          objects,
          placements,
          expected: expectedLayoutSnapshot(
            currentBoard,
            new Map(sourcePlacements.map((placement) => [placement.object_id, placement]))
          ),
        };
        if (!layoutIntentIsCurrent(intent)) return;
        const result = (await client.service('boards').patch(currentBoard.board_id, {
          _action: 'applyLayout',
          ...batch,
        } as unknown as Partial<Board>)) as unknown as BoardLayoutApplyResult;
        if (!layoutResultCoversBatch(result, batch)) {
          throw new Error('Board layout acknowledgement omitted committed geometry');
        }
        acknowledgeExpectedAutoLayouts(explicitExpectationZoneIds);
        if (!layoutIntentIsCurrent(intent)) return;
        setNodes((nodes) => nodes.map((node) => arrangedNodeById.get(node.id) ?? node));
        onArrangeNodes?.(arrangedNodes, dealTiming({ count: arrangedNodes.length }).totalMs);
        completeUserLayout({
          userInitiated,
          viewportIntentToken,
          scope: layoutScope,
          mode: viewportMode,
          beforeNodes: currentNodes,
          afterNodes,
          affectedNodeIds,
        });
        showSuccess(
          `Arranged ${plan.zones.length} zone${plan.zones.length === 1 ? '' : 's'}, ${plan.looseItems.length} free item${plan.looseItems.length === 1 ? '' : 's'}, and their contents.`
        );
      } catch (error) {
        clearExpectedAutoLayouts(explicitExpectationZoneIds);
        if (isBoardLayoutSnapshotStale(error)) {
          const attempt = recovery?.attempt ?? 0;
          if (!layoutIntentIsCurrent(intent)) return;
          if (attempt < MAX_LAYOUT_STALE_REPLANS) {
            try {
              const source = await fetchAuthoritativeLayoutSource(
                client,
                currentBoard.board_id,
                nodesRef.current
              );
              if (!source || !layoutIntentIsCurrent(intent)) {
                if (userInitiated && layoutIntentIsCurrent(intent)) {
                  showError(
                    'The board changed while arranging. Try again after it finishes loading.'
                  );
                }
                return;
              }
              await arrangeBoardZones(zoneIds, {
                ...options,
                recovery: {
                  attempt: attempt + 1,
                  intent,
                  source,
                  viewportIntentToken,
                },
              });
            } catch (refreshError) {
              console.error('Failed to refresh current board layout:', refreshError);
              if (userInitiated) showError('Failed to refresh the current board layout');
            }
            return;
          }
          if (userInitiated) {
            showError('The board changed again while arranging. Try again.');
          }
          return;
        }
        console.error('Failed to arrange board zones:', error);
        showError(
          error instanceof LayoutObstacleError
            ? 'The selected layout cannot fit without overlapping fixed board objects.'
            : 'Failed to arrange zones'
        );
      } finally {
        if (ownsInFlight) {
          boardArrangementInFlightRef.current = false;
          setIsBoardArrangementActive(false);
        }
      }
    },
    [
      acknowledgeExpectedAutoLayouts,
      beginBoardLayoutIntent,
      boardObjectsForBoard,
      clearExpectedAutoLayouts,
      client,
      completeUserLayout,
      layoutIntentIsCurrent,
      onUserLayoutStart,
      onArrangeNodes,
      restoreZoneCallouts,
      setNodes,
      showError,
      showSuccess,
    ]
  );

  /** Main-toolbar entry into the exact planner used by selected-zone Arrange. */
  const arrangeWholeBoard = useCallback(
    async (
      options:
        | boolean
        | Omit<
            ArrangeBoardZonesOptions,
            'userInitiated' | 'layoutScope' | 'selectedRootIds' | 'fixedObstacles'
          > = {}
    ) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const { selectedZones, looseNodes } = getBoardArrangementCandidates(
        currentBoard,
        nodesRef.current
      );
      if (selectedZones.length === 0 && looseNodes.length === 0) return;
      const arrangementOptions =
        typeof options === 'boolean' ? { packZoneContents: options } : options;
      await arrangeBoardZones(
        selectedZones.map(([zoneId]) => zoneId),
        {
          userInitiated: true,
          layoutScope: 'board',
          density: 'preserve',
          ...arrangementOptions,
        }
      );
    },
    [arrangeBoardZones]
  );

  const currentBoardArrangementCandidates = board
    ? getBoardArrangementCandidates(board, nodes)
    : undefined;
  const canArrangeWholeBoard = Boolean(
    currentBoardArrangementCandidates &&
      (currentBoardArrangementCandidates.selectedZones.length > 0 ||
        currentBoardArrangementCandidates.looseNodes.length > 0)
  );

  runAutoZoneArrangeRef.current = (zoneId: string, expectedLease?: AutoZoneObserverLease) => {
    const currentBoard = boardRef.current;
    const lease = autoZoneObserverLeaseRef.current;
    const zone = currentBoard?.objects?.[zoneId];
    if (
      !currentBoard ||
      (expectedLease !== undefined && expectedLease !== lease) ||
      !lease.owned ||
      lease.boardId !== currentBoard.board_id ||
      zone?.type !== 'zone' ||
      normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto' ||
      manuallyControlledZoneIdsRef.current.has(zoneId)
    )
      return;
    restoreZoneCallouts(zoneId);
    const preserveZoneFrame = preserveNextAutoZoneFrameRef.current.delete(zoneId);
    void arrangeZoneContentsRef.current?.(zoneId, {
      silent: true,
      preserveZoneFrame,
      observerLease: lease,
    });
  };

  useEffect(() => {
    const autoZones = Object.entries(boardObjects ?? {}).flatMap(([objectId, object]) =>
      object.type === 'zone' &&
      normalizeZoneLayoutPolicy(object.layout).mode === 'auto' &&
      !manuallyControlledZoneIdsRef.current.has(objectId)
        ? ([[objectId, object]] as const)
        : []
    );
    if (
      !client ||
      !ownsAutoZoneObserver ||
      !autoZoneObserverLeaseRef.current.owned ||
      autoZoneObserverLeaseRef.current.boardId !== board?.board_id
    )
      return;
    if (autoZones.length === 0) {
      // Re-arming a zone must tidy even when its contents have not changed
      // since the last time auto mode ran.
      lastAutoLayoutSignaturesRef.current = new Map();
      return;
    }

    const autoZoneForCanvasNode = new Map<string, string>();
    const durablePlacementByNodeId = new Map<string, BoardEntityObject>();
    for (const placement of boardObjectsForBoard) {
      const nodeId = placementNodeId(placement);
      if (nodeId) durablePlacementByNodeId.set(nodeId, placement);
    }
    for (const node of nodes) {
      if (!isPositionableZoneCanvasNode(node)) continue;
      const containing = autoZones
        .filter(([, zone]) => nodeCenterInsideZone(node, zone))
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.width * left.height - right.width * right.height || leftId.localeCompare(rightId)
        )[0];
      if (containing) autoZoneForCanvasNode.set(node.id, containing[0]);
    }

    const observerInputs: AutoZoneObserverInput[] = autoZones.map(([zoneId, zone]) => ({
      zoneId,
      width: zone.width,
      height: zone.height,
      layout: zone.layout,
      children: nodes
        .filter((node) => {
          if (node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode'))
            return true;
          return autoZoneForCanvasNode.get(node.id) === zoneId;
        })
        .map((node) => {
          const size = canonicalAutoZoneItemSize(
            node,
            durablePlacementByNodeId.get(node.id),
            boardObjects?.[node.id],
            false
          );
          return {
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            width: size.width,
            height: size.height,
            sortData: autoZoneObserverSortData(node),
          };
        }),
    }));
    const observation = changedAutoZoneObserverIds(
      observerInputs,
      lastAutoLayoutSignaturesRef.current
    );
    lastAutoLayoutSignaturesRef.current = observation.signatures;
    if (observation.changedIds.size === 0) return;
    const changedZones = autoZones.filter(([zoneId]) => observation.changedIds.has(zoneId));
    const unsuppressedZones = changedZones.filter(([zoneId]) => {
      const expected = expectedAutoLayoutSignaturesRef.current.get(zoneId);
      const current = observation.signatures.get(zoneId);
      const state = expectedAutoLayoutState(current, expected);
      if (!state.suppress) return true;
      autoZoneDeferralRef.current?.cancel(zoneId);
      if (state.settled) {
        expectedAutoLayoutSignaturesRef.current.delete(zoneId);
      }
      return false;
    });
    const zonesToArrange = zonesNeedingAutoArrange(
      unsuppressedZones,
      skipNextAutoArrangeRef.current
    );
    if (zonesToArrange.length === 0) return;
    for (const [zoneId] of zonesToArrange) {
      const lease = autoZoneObserverLeaseRef.current;
      autoZoneDeferralRef.current?.schedule(
        zoneId,
        () => runAutoZoneArrangeRef.current(zoneId, lease),
        AUTO_ZONE_BASE_DELAY_MS
      );
    }
  }, [board?.board_id, boardObjects, boardObjectsForBoard, client, nodes, ownsAutoZoneObserver]);

  /**
   * Convert board.objects to React Flow nodes
   */
  const getBoardObjectNodes = useCallback((): Node[] => {
    if (!boardObjects) return [];

    const zoneEntries = Object.entries(boardObjects).filter(
      (entry): entry is [string, Extract<BoardObject, { type: 'zone' }>] => entry[1].type === 'zone'
    );
    const zonePeers = zoneEntries.map(([id, zone]) => ({
      id,
      zIndex: sanitizeZIndex(zone.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
    }));

    return Object.entries(boardObjects)
      .filter(([objectId, objectData]) => {
        // Legacy text annotations have no desktop renderer. Do not fall
        // through to the zone renderer: their optional width previously made
        // the portaled zone toolbar calculate `left: NaN`.
        if (objectData.type === 'text') return false;
        // Reject non-finite durable geometry at the React Flow node boundary.
        // This is a source guard, not a CSS fallback: invalid objects never
        // enter React Flow's transform or portal calculations.
        const hasValidPosition =
          typeof objectData.x === 'number' &&
          typeof objectData.y === 'number' &&
          Number.isFinite(objectData.x) &&
          Number.isFinite(objectData.y);
        const width = 'width' in objectData ? objectData.width : undefined;
        const height = 'height' in objectData ? objectData.height : undefined;
        const hasPositiveFiniteWidth = Number.isFinite(width) && Number(width) > 0;
        const hasPositiveFiniteHeight = Number.isFinite(height) && Number(height) > 0;
        const hasValidSize =
          objectData.type === 'markdown'
            ? hasPositiveFiniteWidth
            : hasPositiveFiniteWidth && hasPositiveFiniteHeight;

        if (!hasValidPosition || !hasValidSize) {
          console.warn('Skipping board object with invalid geometry:', {
            objectId,
            type: objectData.type,
          });
        }

        return hasValidPosition && hasValidSize;
      })
      .map(([objectId, objectData]) => {
        // App node (live Sandpack preview)
        if (objectData.type === 'app') {
          return {
            id: objectId,
            type: 'appNode',
            position: { x: objectData.x, y: objectData.y },
            draggable: canEdit,
            selectable: true,
            // Above markdown (300), below branches (500) by default.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.app),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              title: objectData.title,
              description: objectData.description,
              template: objectData.template,
              files: objectData.files,
              dependencies: objectData.dependencies,
              entryFile: objectData.entryFile,
              showEditor: objectData.showEditor,
              showConsole: objectData.showConsole,
              width: objectData.width,
              height: objectData.height,
              canEdit,
              onUpdate: handleUpdateObject,
              onDelete: deleteObject,
            },
          };
        }

        // Artifact node (filesystem-backed Sandpack preview)
        if (objectData.type === 'artifact') {
          const isLocked = objectData.locked ?? false;
          return {
            id: objectId,
            type: 'artifactNode',
            position: { x: objectData.x, y: objectData.y },
            draggable: canEdit && !isLocked,
            selectable: true,
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.artifact),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              artifactId: objectData.artifact_id,
              width: objectData.width,
              height: objectData.height,
              locked: isLocked,
              x: objectData.x,
              y: objectData.y,
              canEdit,
              isActiveUrlTarget: objectData.artifact_id === activeUrlTargetArtifactId,
              onUpdate: handleUpdateObject,
              onDeleteArtifact: deleteArtifact,
            },
          };
        }

        // Markdown note node
        if (objectData.type === 'markdown') {
          return {
            id: objectId,
            type: 'markdown',
            position: { x: objectData.x, y: objectData.y },
            draggable: canEdit,
            selectable: true,
            // Above zones (100), below branches (500) by default.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.markdown),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              content: objectData.content,
              width: objectData.width,
              canEdit,
              onUpdate: handleUpdateObject,
              onEdit: onEditMarkdown,
              onDelete: deleteObject,
            },
          };
        }

        // Count entities pinned to this zone via board_objects.zone_id.
        // Deliberately avoid subscribing the whole canvas to sessionsByBranch:
        // streaming session patches are high-frequency and should only update
        // the affected BranchCard's per-branch selector, not rebuild every
        // React Flow node on the board.
        let pinnedItemCount = 0;
        let positionableItemCount = 0;
        // Density is a capability, not a synonym for "pinned". Generic cards
        // are positionable but do not own a collapsible secondary surface.
        let densityExpandableItemCount = 0;
        let compactDensityExpandableItemCount = 0;
        if (objectData.type === 'zone') {
          for (const boardObj of boardObjectsForBoard) {
            if (boardObj.zone_id === objectId && (boardObj.branch_id || boardObj.card_id)) {
              pinnedItemCount += 1;
              positionableItemCount += 1;
              const nodeId = placementNodeId(boardObj);
              const node = nodeId
                ? nodesRef.current.find((candidate) => candidate.id === nodeId)
                : undefined;
              if (isDensityExpandablePlacement(boardObj, node)) {
                densityExpandableItemCount += 1;
                if (boardObj.compact === true) compactDensityExpandableItemCount += 1;
              }
            }
          }
          positionableItemCount += nodesRef.current.filter(
            (node) => isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, objectData)
          ).length;
        }

        // Zone node
        const isLocked = objectData.type === 'zone' ? objectData.locked : false;
        return {
          id: objectId,
          type: 'zone',
          position: { x: objectData.x, y: objectData.y },
          draggable: canEdit && !isLocked,
          // Zones behind branches and comments by default; honor explicit order.
          zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
          className: eraserMode ? 'eraser-mode' : undefined,
          // Set dimensions both as direct props (for collision detection) and style (for rendering)
          width: objectData.width,
          height: objectData.height,
          style: {
            width: objectData.width,
            height: objectData.height,
          },
          data: {
            objectId,
            label: objectData.type === 'zone' ? objectData.label : '',
            width: objectData.width,
            height: objectData.height,
            borderColor: objectData.type === 'zone' ? objectData.borderColor : undefined,
            backgroundColor: objectData.type === 'zone' ? objectData.backgroundColor : undefined,
            color: objectData.color, // Backwards compatibility
            status: objectData.type === 'zone' ? objectData.status : undefined,
            locked: isLocked,
            fontSize: objectData.type === 'zone' ? objectData.fontSize : undefined,
            // Effective base zIndex (persisted or per-type default). Consumed by
            // the selection-bump logic in SessionCanvas so a selected zone
            // restores to its own order on deselect.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
            x: objectData.x, // Include position in data for updates
            y: objectData.y,
            trigger: objectData.type === 'zone' ? objectData.trigger : undefined,
            layout: objectData.type === 'zone' ? objectData.layout : undefined,
            layout_binding: objectData.type === 'zone' ? objectData.layout_binding : undefined,
            boardZoneLayoutDefaults: board?.zone_layout_defaults,
            pinnedItemCount,
            positionableItemCount,
            densityExpandableItemCount,
            compactDensityExpandableItemCount,
            canEdit,
            overlappingZoneCount:
              objectData.type === 'zone'
                ? zoneEntries.filter(
                    ([peerId, peer]) => peerId !== objectId && zonesOverlap(objectData, peer)
                  ).length
                : 0,
            layerAvailability:
              objectData.type === 'zone'
                ? (['front', 'forward', 'backward', 'back'] as const).reduce(
                    (availability, op) => {
                      availability[op] = computeLayerChanges(op, objectId, zonePeers).length > 0;
                      return availability;
                    },
                    {} as Record<LayerOp, boolean>
                  )
                : undefined,
            onUpdate: handleUpdateObject,
            onDelete: deleteZone,
            onReorder: reorderObject,
            onArrangeContents: (zoneId: string) =>
              arrangeZoneContents(zoneId, { userInitiated: true }),
            onJustifyContents: justifyZoneContents,
            onSetContentsCompact: setZoneContentsCompact,
          },
        };
      });
  }, [
    boardObjects,
    boardObjectsForBoard,
    handleUpdateObject,
    deleteZone,
    deleteObject,
    deleteArtifact,
    reorderObject,
    arrangeZoneContents,
    justifyZoneContents,
    setZoneContentsCompact,
    eraserMode,
    activeUrlTargetArtifactId,
    board?.zone_layout_defaults,
    onEditMarkdown,
    canEdit,
  ]);

  /**
   * Add a zone node at the specified position
   */
  const addZoneNode = useCallback(
    async (x: number, y: number) => {
      const currentBoard = boardRef.current;
      if (!canEditRef.current || !currentBoard || !client) return;

      const objectId = `zone-${Date.now()}`;
      const width = 400;
      const height = 600;
      const inheritedLayout = normalizeZoneLayoutPolicy(currentBoard.zone_layout_defaults);

      // Optimistic update
      setNodes((nodes) => [
        ...nodes,
        {
          id: objectId,
          type: 'zone',
          position: { x, y },
          draggable: canEdit,
          zIndex: DEFAULT_BOARD_OBJECT_Z_INDEX.zone, // Zones behind branches and comments
          style: {
            width,
            height,
          },
          data: {
            objectId,
            label: 'New Zone',
            width,
            height,
            color: undefined, // Will use theme default (colorBorder)
            layout: inheritedLayout,
            layout_binding: 'inherit',
            boardZoneLayoutDefaults: currentBoard.zone_layout_defaults,
            canEdit,
            onUpdate: handleUpdateObject,
          },
        },
      ]);

      // Persist atomically
      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData: {
            type: 'zone',
            x,
            y,
            width,
            height,
            label: 'New Zone',
            layout: inheritedLayout,
            layout_binding: 'inherit',
            // No color specified - will use theme default
          },
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to add zone node:', error);
        // Rollback
        setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
      }
    },
    [canEdit, client, setNodes, handleUpdateObject] // Removed board dependency
  );

  /**
   * Batch update positions for board objects after drag
   */
  const batchUpdateObjectPositions = useCallback(
    async (updates: Record<string, { x: number; y: number; width?: number; height?: number }>) => {
      const currentBoard = boardRef.current;
      if (!canEditRef.current || !currentBoard || !client || Object.keys(updates).length === 0)
        return;

      try {
        // Build objects payload with full object data + new positions
        const objects: Record<string, BoardObject> = {};

        for (const [objectId, position] of Object.entries(updates)) {
          // Skip objects that have been deleted locally
          if (deletedObjectsRef.current.has(objectId)) {
            continue;
          }

          const existingObject = currentBoard.objects?.[objectId];
          if (!existingObject) continue;

          objects[objectId] = {
            ...existingObject,
            x: position.x,
            y: position.y,
            ...(position.width === undefined ? {} : { width: position.width }),
            ...(position.height === undefined ? {} : { height: position.height }),
          } as BoardObject;
        }

        if (Object.keys(objects).length === 0) {
          return;
        }

        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'batchUpsertObjects',
          objects,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to persist object positions:', error);
      }
    },
    [client, deletedObjectsRef] // Removed board dependency
  );

  return {
    getBoardObjectNodes,
    handleUpdateObject,
    addZoneNode,
    deleteObject,
    deleteZone,
    reorderObject,
    demoteAutoZone,
    deferAutoZone,
    setPlacementCompact,
    setZoneContentsCompact,
    justifyZoneContents,
    arrangeBoardZones,
    arrangeWholeBoard,
    canArrangeWholeBoard,
    isBoardArrangementActive,
    cancelPendingLayoutRecovery,
    preserveAutoZoneFrameOnce,
    batchUpdateObjectPositions,
    zoneStackByNodeId,
    calledOutNodeIds,
    calledOutZoneStackZIndex: CALLED_OUT_ZONE_STACK_Z_INDEX,
  };
};
