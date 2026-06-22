import type { Branch } from '@agor-live/client';

export type BranchEnvironmentAction = 'start' | 'stop' | 'restart';

interface BranchEnvironmentRouteService {
  create(data: Record<string, never>): Promise<unknown>;
}

export interface BranchEnvironmentRouteClient {
  service(path: string): BranchEnvironmentRouteService;
}

/**
 * Request an environment lifecycle action through the daemon's public REST route.
 *
 * The Feathers client does not expose the daemon's server-only custom
 * `startEnvironment`/`stopEnvironment`/`restartEnvironment` methods on the
 * `branches` service proxy. These route services map to:
 *   POST /branches/:id/start
 *   POST /branches/:id/stop
 *   POST /branches/:id/restart
 */
export async function requestBranchEnvironmentAction(
  client: BranchEnvironmentRouteClient,
  branchId: string,
  action: BranchEnvironmentAction
): Promise<Branch> {
  const route = `branches/${encodeURIComponent(branchId)}/${action}`;
  return (await client.service(route).create({})) as Branch;
}
