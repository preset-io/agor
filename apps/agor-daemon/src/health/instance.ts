/**
 * The `/health` `instance` section. The public payload carries deployment
 * config only: resolving a tenant label before login would disclose it to
 * anyone who knows the hostname. Authenticated callers get their own tenant's
 * launch-observed label, falling back to `daemon.instanceLabel`.
 */

import type { AgorConfig } from '@agor/core/config';
import type { TenantDisplay } from '@agor/core/types';

export interface HealthInstance {
  label?: string;
  description?: string;
  externalAppLink?: string;
  externalAppLabel?: string;
}

/** Pre-login instance identity: deployment config, never tenant data. */
export function publicHealthInstance(config: AgorConfig): HealthInstance {
  return {
    label: config.daemon?.instanceLabel,
    description: config.daemon?.instanceDescription,
    externalAppLink: config.daemon?.externalAppLink,
    externalAppLabel: config.daemon?.externalAppLabel,
  };
}

/**
 * Authenticated instance identity. `readTenantDisplay` must run under the
 * caller's tenant scope. The label is cosmetic and `/health` must not fail
 * over it, so an unreadable label falls back to config like an absent one.
 */
export async function authenticatedHealthInstance(
  config: AgorConfig,
  readTenantDisplay: () => Promise<TenantDisplay | null>
): Promise<HealthInstance> {
  const instance = publicHealthInstance(config);
  try {
    const display = await readTenantDisplay();
    return display ? { ...instance, label: display.label } : instance;
  } catch {
    return instance;
  }
}
