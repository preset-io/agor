import type { AgorClient } from '@agor-live/client';
import { useEffect, useMemo, useRef } from 'react';
import { agorStore, useAgorStore } from '../store/agorStore';
import {
  loadBoardPartition,
  makeBoardPartitionSelector,
  makeBoardReadySelector,
  registerBoardUse,
  requestBoardReload,
  retryBoardPartition,
  selectBoardPartition,
} from '../store/boardPartitions';
import { isLoadLifetimeCurrent } from '../store/loadLifetime';

/**
 * Load the displayed board's partition when it is not ready yet, and report
 * readiness. Waits for the gated first paint (which loads the first-paint
 * board's partition itself), dedupes in-flight loads, and retries a failed load
 * when the socket reconnects. Returns `boardReady` — gate every "absent means
 * none / no access" inference on it (invariant I1).
 *
 * The consumer registers its use of `boardId`: as the displayed board (the
 * one a reconnect resync reconciles first) unless it passes `background`, so
 * a consumer that loads a board it doesn't display (mobile navigation
 * expanding another board) never takes that priority from the board shell.
 * Once released, the partition stays among the recently used background
 * partitions until the LRU evicts it (`evictInactivePartitions`).
 */
export function useBoardPartition(
  client: AgorClient | null,
  boardId: string | null | undefined,
  options: { canUseMemberWorkspaceServices: boolean; background?: boolean }
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
  const { canUseMemberWorkspaceServices, background = false } = options;
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
    const current = selectBoardPartition(agorStore.getState(), boardId);
    if (current && isLoadLifetimeCurrent(current) && (status === 'loading' || status === 'error')) {
      return;
    }
    // Loaded but incomplete (a branch arrived from an unloaded board): read
    // again, coalescing a burst of arrivals.
    if (current && isLoadLifetimeCurrent(current) && status === 'loaded') {
      requestBoardReload(client, boardId, { canUseMemberWorkspaceServices, background });
      return;
    }
    void loadBoardPartition(client, boardId, { canUseMemberWorkspaceServices, background });
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
    background,
  ]);

  // Publish the use: a reconnect resync reconciles the displayed board in
  // place, and the LRU never evicts a mounted board (`registerBoardUse`).
  // Register the new board before releasing the old one: a release runs the
  // LRU, which would otherwise see no displayed board and could evict the
  // board being navigated to.
  const releaseUse = useRef<(() => void) | null>(null);
  useEffect(() => {
    const previous = releaseUse.current;
    releaseUse.current = boardId && boardKnown ? registerBoardUse(boardId, background) : null;
    previous?.();
  }, [background, boardId, boardKnown]);
  useEffect(
    () => () => {
      releaseUse.current?.();
      releaseUse.current = null;
    },
    []
  );

  // A failed load retries automatically once the socket reconnects.
  useEffect(() => {
    if (!client || !boardId || status !== 'error') return;
    const retry = () => {
      if (selectBoardPartition(agorStore.getState(), boardId)?.status === 'error') {
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
