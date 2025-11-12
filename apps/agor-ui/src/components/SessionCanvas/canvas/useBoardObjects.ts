/**
 * Hook for managing board objects (text labels, zones, etc.)
 */

import type { AgorClient } from '@agor/core/api';
import type { Board, BoardEntityObject, BoardObject, Session, Worktree } from '@agor/core/types';
import { useCallback, useMemo, useRef } from 'react';
import type { Node } from 'reactflow';

interface UseBoardObjectsProps {
  board: Board | null;
  client: AgorClient | null;
  sessions: Session[];
  worktrees: Worktree[];
  boardObjects: BoardEntityObject[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  deletedObjectsRef: React.MutableRefObject<Set<string>>;
  eraserMode?: boolean;
  selectedSessionId?: string | null;
}

export const useBoardObjects = ({
  board,
  client,
  sessions,
  worktrees,
  boardObjects,
  setNodes,
  deletedObjectsRef,
  eraserMode = false,
  selectedSessionId,
}: UseBoardObjectsProps) => {
  // Use ref to avoid recreating callbacks when board changes
  const boardRef = useRef(board);
  boardRef.current = board;

  // Get session IDs for this board (worktree-centric model)
  const _boardSessionIds = useMemo(() => {
    if (!board) return [];
    const boardWorktreeIds = new Set(
      worktrees.filter(w => w.board_id === board.board_id).map(w => w.worktree_id)
    );
    return sessions
      .filter(s => s.worktree_id && boardWorktreeIds.has(s.worktree_id))
      .map(s => s.session_id);
  }, [board, worktrees, sessions]);

  /**
   * Update an existing board object
   */
  const handleUpdateObject = useCallback(
    async (objectId: string, objectData: BoardObject) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData,
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);
      } catch (error) {
        console.error('Failed to update object:', error);
      }
    },
    [client] // Only depend on client, not board
  );

  /**
   * Delete a zone (worktree-centric: zones can pin worktrees)
   */
  const deleteZone = useCallback(
    async (objectId: string, _deleteAssociatedSessions: boolean) => {
      if (!board || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Find worktrees that are pinned to this zone (via board_objects.zone_id)
      const affectedWorktreeIds: string[] = [];
      for (const boardObj of boardObjects) {
        if (boardObj.zone_id === objectId) {
          affectedWorktreeIds.push(boardObj.worktree_id);
        }
      }

      // Optimistic removal of zone (just the zone node, worktrees remain but unpinned)
      setNodes(nodes => nodes.filter(n => n.id !== objectId));

      try {
        await client.service('boards').patch(board.board_id, {
          _action: 'deleteZone',
          objectId,
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);

        // Unpin any worktrees that were pinned to this zone
        for (const worktreeId of affectedWorktreeIds) {
          const boardObj = boardObjects.find(
            (obj: BoardEntityObject) => obj.worktree_id === worktreeId
          );
          if (boardObj) {
            await client.service('board-objects').patch(boardObj.object_id, {
              zone_id: null,
            });
          }
        }

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
    [board, client, setNodes, deletedObjectsRef, boardObjects]
  );

  /**
   * Convert board.objects to React Flow nodes
   */
  const getBoardObjectNodes = useCallback((): Node[] => {
    if (!board?.objects) return [];

    return Object.entries(board.objects)
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
      .map(([objectId, objectData]) => {
        // Calculate worktree count for this zone (worktree-centric model)
        let sessionCount = 0;
        if (objectData.type === 'zone') {
          // Count worktrees pinned to this zone via board_objects.zone_id
          for (const boardObj of boardObjects) {
            if (boardObj.zone_id === objectId) {
              // Count sessions in this worktree
              const worktreeSessions = sessions.filter(s => s.worktree_id === boardObj.worktree_id);
              sessionCount += worktreeSessions.length;
            }
          }
        }

        // Zone node
        const isLocked = objectData.type === 'zone' ? objectData.locked : false;
        return {
          id: objectId,
          type: 'zone',
          position: { x: objectData.x, y: objectData.y },
          draggable: !isLocked, // Respect locked state
          zIndex: 100, // Zones behind worktrees and comments
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
            x: objectData.x, // Include position in data for updates
            y: objectData.y,
            trigger: objectData.type === 'zone' ? objectData.trigger : undefined,
            sessionCount,
            onUpdate: handleUpdateObject,
            onDelete: deleteZone,
          },
        };
      });
  }, [board?.objects, boardObjects, sessions, handleUpdateObject, deleteZone, eraserMode]);

  /**
   * Add a zone node at the specified position
   */
  const addZoneNode = useCallback(
    async (x: number, y: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      const objectId = `zone-${Date.now()}`;
      const width = 400;
      const height = 600;

      // Optimistic update
      setNodes(nodes => [
        ...nodes,
        {
          id: objectId,
          type: 'zone',
          position: { x, y },
          draggable: true,
          zIndex: 100, // Zones behind worktrees and comments
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
            // No color specified - will use theme default
          },
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);
      } catch (error) {
        console.error('Failed to add zone node:', error);
        // Rollback
        setNodes(nodes => nodes.filter(n => n.id !== objectId));
      }
    },
    [client, setNodes, handleUpdateObject] // Removed board dependency
  );

  /**
   * Delete a board object
   */
  const deleteObject = useCallback(
    async (objectId: string) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes(nodes => nodes.filter(n => n.id !== objectId));

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'removeObject',
          objectId,
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);

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
   * Batch update positions for board objects after drag
   */
  const batchUpdateObjectPositions = useCallback(
    async (updates: Record<string, { x: number; y: number }>) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client || Object.keys(updates).length === 0) return;

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
          return;
        }

        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'batchUpsertObjects',
          objects,
          // biome-ignore lint/suspicious/noExplicitAny: Board patch with custom _action field
        } as any);
      } catch (error) {
        console.error('Failed to persist object positions:', error);
      }
    },
    [client, deletedObjectsRef] // Removed board dependency
  );

  return {
    getBoardObjectNodes,
    addZoneNode,
    deleteObject,
    deleteZone,
    batchUpdateObjectPositions,
  };
};
