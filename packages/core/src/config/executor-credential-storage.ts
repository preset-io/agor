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
