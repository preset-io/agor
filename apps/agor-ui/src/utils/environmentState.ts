import type { WorktreeEnvironmentInstance } from '@agor-live/client';

/**
 * Inferred environment state combining runtime status + health check
 *
 * This provides a more accurate representation of environment health by combining:
 * - Runtime status (stopped, starting, running, stopping, error)
 * - Health check status (healthy, unhealthy, unknown)
 */
export type EnvironmentInferredState =
  | 'stopped'
  | 'starting'
  | 'healthy' // running + healthy check
  | 'unhealthy' // running + unhealthy check
  | 'running' // running + no health check or unknown
  | 'stopping'
  | 'error';

/**
 * Infer environment state by combining runtime status + health check
 *
 * @param env - The environment instance from the worktree
 * @returns The inferred state
 *
 * @example
 * ```ts
 * const state = getEnvironmentState(worktree.environment_instance);
 * // state = 'healthy' | 'unhealthy' | 'running' | 'stopped' | ...
 * ```
 */
export function getEnvironmentState(env?: WorktreeEnvironmentInstance): EnvironmentInferredState {
  if (!env) return 'stopped';

  // If running, combine with health check
  if (env.status === 'running') {
    const healthStatus = env.last_health_check?.status;
    if (healthStatus === 'healthy') return 'healthy';
    if (healthStatus === 'unhealthy') return 'unhealthy';
    return 'running'; // no health check configured or unknown
  }

  // Otherwise use runtime status directly
  return env.status;
}

/**
 * Get a human-readable description of the environment state
 */
export function getEnvironmentStateDescription(state: EnvironmentInferredState): string {
  switch (state) {
    case 'stopped':
      return 'Stopped';
    case 'starting':
      return 'Starting...';
    case 'healthy':
      return 'Healthy';
    case 'unhealthy':
      return 'Unhealthy';
    case 'running':
      return 'Running';
    case 'stopping':
      return 'Stopping...';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}
