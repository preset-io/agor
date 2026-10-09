/**
 * Hook for managing board objects (text labels, zones, etc.)
 */

import type { AgorClient, Board, BoardEntityObject, BoardObject } from '@agor-live/client';
import { useCallback, useRef } from 'react';
import type { Node } from 'reactflow';
import {
  type BoardMutationGuard,
  type BoardWriteResult,
  useBoardMutationGuard,
} from '../../../hooks/useBoardMutationGuard';
import type { BoardWriteTicket } from '../../../store/boardMutationGuard';
import { useThemedMessage } from '../../../utils/message';
import {
  computeLayerChanges,
  DEFAULT_BOARD_OBJECT_Z_INDEX,
  type LayerOp,
  sanitizeZIndex,
} from './zOrder';

interface UseBoardObjectsProps {
  board: Board | null;
  client: AgorClient | null;
  boardObjectsForBoard: BoardEntityObject[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  deletedObjectsRef: React.MutableRefObject<Set<string>>;
  eraserMode?: boolean;
  /** Artifact ID currently targeted by an `/a/<…>/` deep link. Used to
   *  flag the matching ArtifactNode so it can render the dashed
   *  "selected" outline. */
  activeUrlTargetArtifactId?: string | null;
  onEditMarkdown?: (objectId: string, content: string, width: number) => void;
  /** A zone node unmounted with an unsaved draft (see `ZoneNodeData.onDraftLost`). */
  onZoneDraftLost?: (draft: { objectId: string; zoneName: string; text: string }) => void;
  /**
   * The canvas's board.edit write guard. Every board-object write passes it
   * under an explicit ticket: immediate actions capture one when they run,
   * dialogs and editors pass the one captured when they opened, and batches
   * pass the one of their queue. A write without a current ticket is refused.
   */
  guard: BoardMutationGuard;
}

type ZoneEntry = [string, Extract<BoardObject, { type: 'zone' }>];

function zoneEntriesOf(objects: Record<string, BoardObject>): ZoneEntry[] {
  return Object.entries(objects).filter((entry): entry is ZoneEntry => entry[1].type === 'zone');
}

function zonesOverlap(
  a: Extract<BoardObject, { type: 'zone' }>,
  b: Extract<BoardObject, { type: 'zone' }>
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export const useBoardObjects = ({
  board,
  client,
  boardObjectsForBoard,
  setNodes,
  deletedObjectsRef,
  eraserMode = false,
  activeUrlTargetArtifactId,
  onEditMarkdown,
  onZoneDraftLost,
  guard,
}: UseBoardObjectsProps) => {
  // Use ref to avoid recreating callbacks when board changes
  const boardRef = useRef(board);
  boardRef.current = board;
  const guardRef = useRef(guard);
  guardRef.current = guard;
  const canEdit = guard.canMutate;
  // Artifact lifecycle authorization is creator/admin based rather than
  // board.edit based, but its board object is still board data: it needs the
  // partition loaded and the connection usable like every other write.
  const artifactGuard = useBoardMutationGuard(board?.board_id, true);
  const artifactGuardRef = useRef(artifactGuard);
  artifactGuardRef.current = artifactGuard;

  const { showError } = useThemedMessage();

  // Use the board object's reference directly. The store already preserves
  // unchanged board references, and serializing every object on every canvas
  // render is prohibitively expensive on large boards.
  const boardObjects = board?.objects;

  /**
   * Update an existing board object under `ticket`. Resolves `true` once
   * saved, `false` when the request failed (a dialog stays open to retry), or
   * `'stale'` when the ticket no longer holds: nothing is sent, and a dialog
   * keeps its draft to copy or discard (only reopening captures a new ticket).
   */
  const handleUpdateObject = useCallback(
    async (
      objectId: string,
      objectData: BoardObject,
      ticket: BoardWriteTicket | null
    ): Promise<BoardWriteResult> => {
      if (!client) return false;
      if (!guardRef.current.isCurrent(ticket)) {
        guardRef.current.warnDropped();
        return 'stale';
      }
      try {
        // No await between the check above and this request.
        await client.service('boards').patch(ticket.boardId, {
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
    [client, showError] // Only depend on stable services, not board
  );

  /** An immediate update: its ticket is captured now, and checked at once. */
  const updateObjectNow = useCallback(
    (objectId: string, objectData: BoardObject) =>
      handleUpdateObject(objectId, objectData, guardRef.current.capture()),
    [handleUpdateObject]
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
      const ticket = guardRef.current.capture();
      if (!ticket || !currentBoard || !client) return;

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
        await guardRef.current.write(ticket, () =>
          client.service('boards').patch(ticket.boardId, {
            _action: 'mergeObjectFields',
            objects: patches,
          } as unknown as Partial<Board>)
        );
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
    async (
      objectId: string,
      _deleteAssociatedSessions: boolean,
      ticket: BoardWriteTicket | null
    ) => {
      if (!client) return;
      if (!guardRef.current.isCurrent(ticket)) {
        guardRef.current.warnDropped();
        return;
      }

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal of zone. The SessionCanvas setNodes wrapper clears
      // any orphaned parentId values locally; the daemon owns persistent
      // unpinning and converts zone-relative child positions to absolute.
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(ticket.boardId, {
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
    [client, setNodes, deletedObjectsRef]
  );

  /**
   * Delete a board object under `ticket` (an immediate delete captures one
   * when it runs; a confirmation passes the one captured when it opened).
   */
  const deleteObject = useCallback(
    async (objectId: string, ticket: BoardWriteTicket | null) => {
      if (!client) return;
      if (!guardRef.current.isCurrent(ticket)) {
        guardRef.current.warnDropped();
        return;
      }

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(ticket.boardId, {
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
    async (objectId: string, artifactId: string, ticket: BoardWriteTicket | null) => {
      // Lifecycle-guarded (see `artifactGuard`); the confirmation passes the
      // ticket it captured when it opened.
      if (!client) return;
      if (!artifactGuardRef.current.isCurrent(ticket)) {
        artifactGuardRef.current.warnDropped();
        return;
      }

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
   * The one constructor for every board-object node, hydrated or optimistic:
   * a node created locally before its first realtime ack carries the same
   * ticket plumbing (`beginBoardWrite`, ticket-taking callbacks) as one built
   * from the board record, so an editor or confirmation opened on it captures
   * its ticket when it opens.
   */
  const buildNode = useCallback(
    (objectId: string, objectData: BoardObject, zoneEntries: readonly ZoneEntry[]): Node => {
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
            onUpdate: updateObjectNow,
            onDelete: (id: string) => deleteObject(id, guardRef.current.capture()),
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
            onUpdate: updateObjectNow,
            onDeleteArtifact: deleteArtifact,
            beginArtifactDelete: artifactGuard.capture,
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
            onUpdate: updateObjectNow,
            onEdit: onEditMarkdown,
            onDelete: deleteObject,
            beginBoardWrite: guard.capture,
          },
        };
      }

      // Count entities pinned to this zone via board_objects.zone_id.
      // Deliberately avoid subscribing the whole canvas to sessionsByBranch:
      // streaming session patches are high-frequency and should only update
      // the affected BranchCard's per-branch selector, not rebuild every
      // React Flow node on the board.
      let pinnedItemCount = 0;
      if (objectData.type === 'zone') {
        for (const boardObj of boardObjectsForBoard) {
          if (boardObj.zone_id === objectId && (boardObj.branch_id || boardObj.card_id)) {
            pinnedItemCount += 1;
          }
        }
      }
      const zonePeers = zoneEntries.map(([id, zone]) => ({
        id,
        zIndex: sanitizeZIndex(zone.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
      }));

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
          pinnedItemCount,
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
          beginBoardWrite: guard.capture,
          onDraftLost: onZoneDraftLost,
        },
      };
    },
    [
      boardObjectsForBoard,
      handleUpdateObject,
      updateObjectNow,
      deleteZone,
      deleteObject,
      deleteArtifact,
      reorderObject,
      eraserMode,
      activeUrlTargetArtifactId,
      onEditMarkdown,
      onZoneDraftLost,
      canEdit,
      guard.capture,
      artifactGuard.capture,
    ]
  );

  /**
   * Convert board.objects to React Flow nodes
   */
  const getBoardObjectNodes = useCallback((): Node[] => {
    if (!boardObjects) return [];

    const zoneEntries = zoneEntriesOf(boardObjects);

    return Object.entries(boardObjects)
      .filter(([, objectData]) => {
        // Filter out objects with invalid positions (prevents NaN errors in React Flow)
        const hasValidPosition =
          typeof objectData.x === 'number' &&
          typeof objectData.y === 'number' &&
          !Number.isNaN(objectData.x) &&
          !Number.isNaN(objectData.y);

        if (!hasValidPosition) {
          console.warn(`Skipping board object with invalid position:`, objectData);
        }

        return hasValidPosition;
      })
      .map(([objectId, objectData]) => buildNode(objectId, objectData, zoneEntries));
  }, [boardObjects, buildNode]);

  /**
   * The node for an object created locally and not yet in the board record
   * (an optimistic create): built exactly like a hydrated one.
   */
  const buildObjectNode = useCallback(
    (objectId: string, objectData: BoardObject): Node =>
      buildNode(
        objectId,
        objectData,
        zoneEntriesOf({ ...boardRef.current?.objects, [objectId]: objectData })
      ),
    [buildNode]
  );

  /**
   * Add a zone node at the specified position
   */
  const addZoneNode = useCallback(
    async (x: number, y: number) => {
      const ticket = guardRef.current.capture();
      if (!ticket || !client) return;

      const objectId = `zone-${Date.now()}`;
      const objectData: BoardObject = {
        type: 'zone',
        x,
        y,
        width: 400,
        height: 600,
        label: 'New Zone',
        // No color specified - will use theme default
      };

      // Optimistic update
      setNodes((nodes) => [...nodes, buildObjectNode(objectId, objectData)]);

      // Persist atomically
      try {
        await client.service('boards').patch(ticket.boardId, {
          _action: 'upsertObject',
          objectId,
          objectData,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to add zone node:', error);
        // Rollback
        setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
      }
    },
    [client, setNodes, buildObjectNode] // Removed board dependency
  );

  /**
   * Batch update positions for board objects after drag
   */
  const batchUpdateObjectPositions = useCallback(
    async (
      updates: Record<string, { x: number; y: number }>,
      ticket: BoardWriteTicket | null
    ): Promise<boolean> => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client || Object.keys(updates).length === 0) return true;
      // The batch's queue ticket, checked right before the request (a batch
      // resumes here after awaiting earlier writes). Resolves false if dropped.
      if (!guardRef.current.isCurrent(ticket) || currentBoard.board_id !== ticket.boardId) {
        return false;
      }

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
          };
        }

        if (Object.keys(objects).length === 0) {
          return true;
        }

        await client.service('boards').patch(ticket.boardId, {
          _action: 'batchUpsertObjects',
          objects,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to persist object positions:', error);
      }
      return true;
    },
    [client, deletedObjectsRef] // Removed board dependency
  );

  return {
    getBoardObjectNodes,
    buildObjectNode,
    addZoneNode,
    deleteObject,
    deleteZone,
    reorderObject,
    batchUpdateObjectPositions,
  };
};
