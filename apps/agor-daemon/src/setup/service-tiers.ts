/**
 * Service tier enforcement hooks for lean daemon mode.
 *
 * These FeathersJS hooks enforce access restrictions based on the configured
 * service tier (internal, readonly, on).
 */

import type { Application } from '@agor/core/feathers';
import { Forbidden } from '@agor/core/feathers';
import type { DaemonServicesConfig, HookContext, ServiceTier } from '@agor/core/types';
import {
  autoPromoteDependencies,
  getServiceTier,
  SERVICE_GROUP_NAMES,
  validateServiceDependencies,
} from '@agor/core/types';

/**
 * FeathersJS hook that blocks ALL external access.
 * Used for 'internal' tier — service is registered for cross-service deps only.
 *
 * context.params.provider is set by FeathersJS for external requests:
 * - 'rest' for REST/HTTP
 * - 'socketio' for WebSocket
 * - undefined for internal app.service().method() calls
 */
export const blockExternalAccess = async (context: HookContext) => {
  if (context.params.provider) {
    throw new Forbidden(`Service '${context.path}' is not available`);
  }
};

/**
 * FeathersJS hook that blocks mutation methods from external callers.
 * Used for 'readonly' tier — allows get/find externally, blocks create/patch/update/remove.
 */
export const blockMutation = async (context: HookContext) => {
  if (context.params.provider) {
    throw new Forbidden(`Service '${context.path}' is in readonly mode`);
  }
};

/**
 * Apply tier-based hooks to a registered service.
 * Call this AFTER app.use() for the service path(s).
 */
export function applyTierHooks(app: Application, servicePath: string, tier: ServiceTier): void {
  if (tier === 'internal') {
    app.service(servicePath).hooks({
      before: {
        all: [blockExternalAccess],
      },
    });
  } else if (tier === 'readonly') {
    app.service(servicePath).hooks({
      before: {
        create: [blockMutation],
        update: [blockMutation],
        patch: [blockMutation],
        remove: [blockMutation],
      },
    });
  }
  // 'on' tier: no additional hooks needed
}

/**
 * Resolve services config: validate dependencies, auto-promote, and log.
 * Returns the effective config to use at runtime.
 */
export function resolveServicesConfig(raw: DaemonServicesConfig | undefined): DaemonServicesConfig {
  if (!raw) return {};

  // Auto-promote dependencies
  const { config: promoted, promotions } = autoPromoteDependencies(raw);

  for (const p of promotions) {
    console.warn(
      `[services] Auto-promoted '${p.group}' from '${p.from}' to '${p.to}' (required by dependency)`
    );
  }

  // Validate remaining issues (shouldn't have any after auto-promote, but just in case)
  const violations = validateServiceDependencies(promoted);
  for (const v of violations) {
    console.error(
      `[services] Dependency violation: '${v.service}' requires '${v.dependency}' to be at least '${v.requiredTier}', but it is '${v.currentTier}'`
    );
  }

  return promoted;
}

/**
 * Log the services configuration summary at daemon startup.
 */
export function logServicesConfig(config: DaemonServicesConfig | undefined): void {
  // Check if any service is non-default (not 'on')
  const hasCustomConfig =
    config && SERVICE_GROUP_NAMES.some((g) => config[g] !== undefined && config[g] !== 'on');

  if (!hasCustomConfig) {
    console.log('[services] All services enabled (default configuration)');
    return;
  }

  console.log('[services] Service configuration:');

  // Format as compact rows
  const rows: string[] = [];
  let currentRow: string[] = [];

  for (const group of SERVICE_GROUP_NAMES) {
    const tier = getServiceTier(config, group);
    currentRow.push(`${group}: ${tier}`);
    if (currentRow.length === 3) {
      rows.push(`  ${currentRow.join(' | ')}`);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    rows.push(`  ${currentRow.join(' | ')}`);
  }

  for (const row of rows) {
    console.log(row);
  }

  // Count disabled services
  const offCount = SERVICE_GROUP_NAMES.filter((g) => getServiceTier(config, g) === 'off').length;
  const internalCount = SERVICE_GROUP_NAMES.filter(
    (g) => getServiceTier(config, g) === 'internal'
  ).length;
  const readonlyCount = SERVICE_GROUP_NAMES.filter(
    (g) => getServiceTier(config, g) === 'readonly'
  ).length;

  if (offCount > 0 || internalCount > 0 || readonlyCount > 0) {
    const parts: string[] = [];
    if (offCount > 0) parts.push(`${offCount} off`);
    if (internalCount > 0) parts.push(`${internalCount} internal`);
    if (readonlyCount > 0) parts.push(`${readonlyCount} readonly`);
    console.log(`[services] Summary: ${parts.join(', ')}`);
  }
}
