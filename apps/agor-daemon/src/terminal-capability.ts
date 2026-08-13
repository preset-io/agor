import type { AgorConfig, ResolvedDeploymentConfig } from '@agor/core/config';

export type WebTerminalCapability = {
  enabled: boolean;
  mode: 'owner-local-ephemeral' | 'disabled';
  reason?: 'operator-disabled' | 'external-runtime-unowned' | 'unsupported-ha-topology';
};

/**
 * Advertise only terminal topologies for which this daemon can own both the
 * create request and the PTY bridge. External executor callbacks currently go
 * through shared ingress and therefore do not have an owner-affine contract.
 */
export function resolveWebTerminalCapability(input: {
  config: AgorConfig;
  deployment: ResolvedDeploymentConfig;
}): WebTerminalCapability {
  const { config, deployment } = input;
  if (config.execution?.allow_web_terminal === false) {
    return { enabled: false, mode: 'disabled', reason: 'operator-disabled' };
  }
  if (config.execution?.executor_command_template?.trim()) {
    return { enabled: false, mode: 'disabled', reason: 'external-runtime-unowned' };
  }
  if (
    deployment.mode === 'ha' &&
    (deployment.topology.execution !== 'shared-local' ||
      deployment.topology.sharedFilesystem !== true ||
      deployment.topology.ingressAffinity !== true)
  ) {
    return { enabled: false, mode: 'disabled', reason: 'unsupported-ha-topology' };
  }
  return { enabled: true, mode: 'owner-local-ephemeral' };
}
