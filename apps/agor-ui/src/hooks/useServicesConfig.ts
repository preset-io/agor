/**
 * useServicesConfig - Access daemon service tier configuration from the UI.
 *
 * Reads the resolved DaemonServicesConfig from the health endpoint (via useAuthConfig)
 * to conditionally show/hide UI sections based on which services are enabled.
 *
 * Delegates to @agor/core pure functions for tier logic — no duplication.
 * Defaults to 'on' for all services when config is absent (backward-compatible).
 */

import type { DaemonServicesConfig, ServiceGroupName, ServiceTier } from '@agor/core/types';
import { getServiceTier, isServiceEnabled, isServiceExternallyAccessible } from '@agor/core/types';
import { useContext } from 'react';
import { ServicesConfigContext } from '../contexts/ServicesConfigContext';

/**
 * Get the full resolved services config from the daemon.
 * Returns undefined if not yet loaded (treat as all-enabled).
 */
export function useServicesConfig(): DaemonServicesConfig | undefined {
  return useContext(ServicesConfigContext);
}

/**
 * Check if a service group is enabled (tier > 'off').
 * Defaults to true when config is not available.
 */
export function useServiceEnabled(group: ServiceGroupName): boolean {
  return isServiceEnabled(useServicesConfig(), group);
}

/**
 * Get the effective tier for a service group.
 * Defaults to 'on' when config is not available.
 */
export function useServiceTier(group: ServiceGroupName): ServiceTier {
  return getServiceTier(useServicesConfig(), group);
}

/**
 * Check if a service group is externally accessible (tier >= 'readonly').
 * Useful for gating UI that reads from a service's API.
 */
export function useServiceReadable(group: ServiceGroupName): boolean {
  return isServiceExternallyAccessible(useServicesConfig(), group);
}
