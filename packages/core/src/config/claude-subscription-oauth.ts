import { EXECUTOR_RESPONSE_PROTOCOL } from '../executor-protocol';
import type { ClaudeOAuthCapability } from '../types/provider-oauth';
import type { ResolvedDeploymentConfig } from './deployment';
import {
  hasContainedClaudeRuntimeCredentials,
  hasExactUserExecutorCredentialHome,
} from './executor-credential-storage';
import { resolveExecutorResponseConfig } from './executor-response';
import type { AgorConfig } from './types';

/** Default-on only when the effective capability below admits a supported mode. */
export function isClaudeSubscriptionOAuthEnabled(config: AgorConfig): boolean {
  return config.agentic_tools?.claude_subscription_oauth !== false;
}

/** Delegated isolation is the existing operator-owned contract, not a local mask. */
export function hasBackendClaudeOAuthTopology(config: AgorConfig): boolean {
  return (
    config.execution?.unix_user_mode === 'delegated' &&
    !!config.execution.executor_command_template?.trim() &&
    hasExactUserExecutorCredentialHome(config)
  );
}

export function resolveClaudeOAuthCapability(
  config: AgorConfig,
  deployment: ResolvedDeploymentConfig,
  authority: { postgres: boolean; encryption: boolean; localIsolation: boolean }
): ClaudeOAuthCapability {
  const unavailable = (
    reason: NonNullable<ClaudeOAuthCapability['reason']>
  ): ClaudeOAuthCapability => ({ available: false, storage: null, reason });
  if (!isClaudeSubscriptionOAuthEnabled(config)) return unavailable('operator_disabled');
  if (hasBackendClaudeOAuthTopology(config)) {
    if (!authority.postgres || !authority.encryption)
      return unavailable('durable_authority_unavailable');
    try {
      const channel = resolveExecutorResponseConfig(config.execution?.executor_response);
      if (
        channel.externalProtocol !== EXECUTOR_RESPONSE_PROTOCOL ||
        !channel.originUrl ||
        (deployment.mode === 'ha' && deployment.topology.execution !== 'external')
      ) {
        return unavailable('runtime_channel_unavailable');
      }
    } catch {
      return unavailable('runtime_channel_unavailable');
    }
    return { available: true, storage: 'backend' };
  }
  if (!hasContainedClaudeRuntimeCredentials(config)) return unavailable('unsupported_execution');
  if (
    !authority.localIsolation ||
    (deployment.mode === 'ha' && !deployment.capabilities.claudeOAuth)
  ) {
    return unavailable('local_isolation_unavailable');
  }
  return { available: true, storage: 'local_file' };
}
