import { hasActiveEnvironmentCommand } from '@agor/core/types';
import type { BranchEnvironmentInstance } from '@agor-live/client';

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
 * @param env - The environment instance from the branch
 * @returns The inferred state
 *
 * @example
 * ```ts
 * const state = getEnvironmentState(branch.environment_instance);
 * // state = 'healthy' | 'unhealthy' | 'running' | 'stopped' | ...
 * ```
 */
export function getEnvironmentState(env?: BranchEnvironmentInstance): EnvironmentInferredState {
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
      return 'Started; health unavailable';
    case 'stopping':
      return 'Stopping...';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}

/**
 * Whether Start and Stop are available, shared by every environment control
 * (the board card pill, the session strip and Branch details). The daemon still
 * enforces permissions; `canControl` only reflects an access decision a parent
 * has already loaded.
 */
export function getEnvironmentControlState(
  env: BranchEnvironmentInstance | undefined,
  {
    hasConfig,
    canControl = true,
    connectionDisabled = false,
  }: { hasConfig: boolean; canControl?: boolean; connectionDisabled?: boolean }
): { startDisabled: boolean; stopDisabled: boolean } {
  const status = env?.status || 'stopped';
  const blocked =
    hasActiveEnvironmentCommand(env) || connectionDisabled || !canControl || !hasConfig;
  const canStop =
    status === 'running' || status === 'starting' || (status === 'error' && !!env?.command_attempt);
  return {
    startDisabled:
      blocked || status === 'starting' || status === 'stopping' || status === 'running',
    stopDisabled: blocked || status === 'stopping' || !canStop,
  };
}
