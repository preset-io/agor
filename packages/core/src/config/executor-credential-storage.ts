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
 * In `sandbox` mode Agor selects the tenant/user-keyed home store directly. In
 * `delegated` mode the external substrate receives the trusted tenant/user home
 * key and this contract asserts that every helper and later Task is routed to
 * that same durable home. Merely declaring `persistent-per-user` while running
 * in `simple` mode does not change the daemon process home.
 */
export function hasExactUserExecutorCredentialHome(config: Pick<AgorConfig, 'execution'>): boolean {
  if (config.execution?.executor_storage?.user_home !== 'persistent-per-user') return false;
  const mode = config.execution?.unix_user_mode ?? 'simple';
  return mode === 'sandbox' || mode === 'delegated';
}

/**
 * Whether the operator asserts that one user home's kernel flock is visible to
 * every HA replica/client that can mutate that home. A merely shared path is
 * insufficient: NFS `local_lock` and similar mounts can expose identical bytes
 * while providing only client-local locks.
 */
export function hasCrossReplicaExecutorCredentialLock(
  config: Pick<AgorConfig, 'execution'>
): boolean {
  return config.execution?.executor_storage?.user_home_locking === 'cross-replica-flock';
}
