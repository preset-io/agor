import type { AgorClient } from '@agor-live/client';
import { useEffect, useMemo } from 'react';
import { agorStore, useAgorStore } from '../store/agorStore';
import {
  isPartitionStateCurrent,
  loadBoardPartition,
  makeBoardPartitionSelector,
  makeBoardReadySelector,
  registerDisplayedBoard,
  retryBoardPartition,
} from '../store/boardPartitions';

/**
 * Load the displayed board's partition when it is not ready yet, and report
 * readiness. Waits for the gated first paint (which loads the first-paint
 * board's partition itself), dedupes in-flight loads, and retries a failed load
 * when the socket reconnects. Returns `boardReady` — gate every "absent means
 * none / no access" inference on it (invariant I1).
 */
export function useBoardPartition(
  client: AgorClient | null,
  boardId: string | null | undefined,
  options: { canUseMemberWorkspaceServices: boolean }
): { boardReady: boolean; status: 'loading' | 'loaded' | 'error' | undefined } {
  const partitionReady = useAgorStore(useMemo(() => makeBoardReadySelector(boardId), [boardId]));
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));
  const status = partition?.status;
  const boardKnown = useAgorStore((s) => (boardId ? s.boardById.has(boardId) : false));
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  // Loads run under the realtime authority: none while disconnected or
  // reauthenticating. A reconnect unloads every board, so the displayed one
  // loads again once the authority is valid (nothing else re-renders this).
  const authority = useAgorStore((s) => s.dataAuthority);
  // A reset orphans loads in flight; request the board again after one.
  const partitionEpoch = useAgorStore((s) => s.partitionEpoch);
  const { canUseMemberWorkspaceServices } = options;
  // Nothing to load without a board, or for one that doesn't exist (boards
  // are global and gated, so after first paint an unknown id never resolves):
  // ready, like `BoardPartitionStatus` — never "Loading board…" forever.
  const boardReady = partitionReady || !boardId || (firstPaintSettled && !boardKnown);

  // biome-ignore lint/correctness/useExhaustiveDependencies: authority and partitionEpoch are re-run triggers
  useEffect(() => {
    if (!client || !boardId || !boardKnown || !firstPaintSettled || !authority) return;
    if (partitionReady) return;
    // An entry from another authority or load lifetime can never settle: it
    // counts as unloaded (authority transitions also forget every entry).
    const current = agorStore.getState().boardPartitions.get(boardId);
    if (isPartitionStateCurrent(current) && (status === 'loading' || status === 'error')) return;
    void loadBoardPartition(client, boardId, { canUseMemberWorkspaceServices });
  }, [
    boardId,
    boardKnown,
    partitionReady,
    canUseMemberWorkspaceServices,
    client,
    firstPaintSettled,
    status,
    authority,
    partitionEpoch,
  ]);

  // Publish the displayed board, so a reconnect resync reconciles this board
  // in place (see `registerDisplayedBoard`).
  useEffect(() => {
    if (!boardId || !boardKnown) return;
    return registerDisplayedBoard(boardId);
  }, [boardId, boardKnown]);

  // A failed load retries automatically once the socket reconnects.
  useEffect(() => {
    if (!client || !boardId || status !== 'error') return;
    const retry = () => {
      if (agorStore.getState().boardPartitions.get(boardId)?.status === 'error') {
        retryBoardPartition(boardId);
      }
    };
    client.io.on('connect', retry);
    return () => {
      client.io.off('connect', retry);
    };
  }, [boardId, client, status]);

  return { boardReady, status };
}
