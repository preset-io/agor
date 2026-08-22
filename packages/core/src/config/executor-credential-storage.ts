import type { AgorConfig } from './types';

/**
 * Whether executor credential files are isolated by trusted user identity in
 * an auth-resolved tenant topology. Static deployments may intentionally use
 * one shared identity; auth-resolved deployments may not.
 */
export function hasTenantSafeExecutorCredentialHome(
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>
): boolean {
  return (
    config.multi_tenancy?.mode !== 'required_from_auth' ||
    config.execution?.executor_storage?.user_home === 'persistent-per-user'
  );
}

/**
 * Whether Codex's native credential file is routed to one durable home for the
 * exact authenticated user.  A static-tenant deployment may deliberately use
 * one shared Unix identity, which is tenant-safe but is not user-isolated and
 * therefore is not sufficient for a device flow that changes credentials on
 * behalf of an individual browser user.
 *
 * Local isolation is concrete only in `sandbox` mode, where Agor selects the
 * tenant/user-keyed home store, explicitly points auth helpers at its `.codex`
 * directory, and bounds normal credential-writer timeouts locally. Ambiguous
 * crash outcomes are user-retryable rather than automatically replayed.
 * Delegated execution can declare an exact home but is outside this deliberately
 * local device-flow implementation, so the capability fails closed there. Merely declaring
 * `persistent-per-user` while running in `simple` mode does not change the
 * daemon process home either.
 */
export function hasExactUserExecutorCredentialHome(config: Pick<AgorConfig, 'execution'>): boolean {
  if (config.execution?.executor_storage?.user_home !== 'persistent-per-user') return false;
  const mode = config.execution?.unix_user_mode ?? 'simple';
  return mode === 'sandbox';
}
