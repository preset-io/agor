import type { AgorClient, BoardBranchCount } from '@agor-live/client';
import { useServerRead } from './useServerRead';

/** Branch events that can change a board's active count (move and archive are patches). */
const BRANCH_EVENTS = ['created', 'patched', 'updated', 'removed'] as const;

const NO_COUNTS = new Map<string, number>();

const readCounts = async (client: AgorClient) =>
  new Map(
    ((await client.service('branch-counts').find()) as BoardBranchCount[]).map((r) => [
      r.board_id as string,
      r.branch_count,
    ])
  );

const onBranchEvents = (client: AgorClient, { invalidate }: { invalidate: () => void }) => {
  const branches = client.service('branches');
  for (const event of BRANCH_EVENTS) branches.on(event, invalidate);
  return () => {
    for (const event of BRANCH_EVENTS) branches.off(event, invalidate);
  };
};

/**
 * Active branches per board, from the `branch-counts` aggregate (the caller's
 * visible branches on visible boards), for the board badges — the store holds
 * only the loaded scopes' branches. Read under the realtime authority (again
 * after a reconnect or identity change) and re-read after branch events
 * (`useServerRead`). A board missing from the map has no active branch.
 */
export function useBranchCounts(client: AgorClient | null): Map<string, number> {
  return (
    useServerRead(client, 'branch-counts', readCounts, { subscribe: onBranchEvents }).data ??
    NO_COUNTS
  );
}
