/**
 * Build the immutable daemon-resolved config slice embedded in executor payloads.
 * The full effective config remains owned by the Feathers application; this
 * module caches only the non-secret executor projection initialized at startup.
 */

import {
  type AgorConfig,
  type ResolvedConfigSlice,
  resolveExecutorHeartbeatConfig,
  resolveSdkWatchdogConfig,
} from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';
import { deepFreeze } from './deep-freeze.js';

let configuredSlice: DeepReadonly<ResolvedConfigSlice> | undefined;

/**
 * Initialize the process-wide executor projection from the app's effective snapshot.
 * Replacement is intentional for tests that start multiple daemon apps in one process.
 */
export function configureResolvedConfigSlice(config: DeepReadonly<AgorConfig>): void {
  configuredSlice = deepFreeze(buildResolvedConfigSlice(config));
}

/** Test-only reset for daemon instances constructed in the same process. */
export function resetResolvedConfigSliceForTests(): void {
  configuredSlice = undefined;
}

export function withResolvedConfig<T extends { resolvedConfig?: unknown }>(payload: T): T {
  if (payload.resolvedConfig !== undefined) return payload;
  if (!configuredSlice) {
    throw new Error('Executor config slice was not initialized from the effective daemon config');
  }
  return { ...payload, resolvedConfig: configuredSlice };
}

export function buildResolvedConfigSlice(config: DeepReadonly<AgorConfig>): ResolvedConfigSlice {
  const slice: ResolvedConfigSlice = {};
  const executionSlice: NonNullable<ResolvedConfigSlice['execution']> = {};
  const permissionTimeoutMs = config.execution?.permission_timeout_ms;
  if (permissionTimeoutMs !== undefined) {
    executionSlice.permission_timeout_ms = permissionTimeoutMs;
  }
  const heartbeat = resolveExecutorHeartbeatConfig(config.execution);
  executionSlice.executor_heartbeat = {
    enabled: heartbeat.enabled,
    interval_ms: heartbeat.interval_ms,
  };
  executionSlice.sdk_watchdog = resolveSdkWatchdogConfig(config.execution);
  if (Object.keys(executionSlice).length > 0) slice.execution = executionSlice;

  const hostIpAddress = config.daemon?.host_ip_address;
  if (hostIpAddress !== undefined) slice.daemon = { host_ip_address: hostIpAddress };
  return slice satisfies ResolvedConfigSlice;
}
