import type { AgorConfig } from '@agor/core/config';

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
export function resolveWebTerminalCapability(config: AgorConfig): WebTerminalCapability {
  if (config.execution?.allow_web_terminal === false) {
    return { enabled: false, mode: 'disabled', reason: 'operator-disabled' };
  }
  if (config.execution?.executor_command_template?.trim()) {
    return { enabled: false, mode: 'disabled', reason: 'external-runtime-unowned' };
  }
  if (
    config.deployment?.mode === 'ha' &&
    (config.deployment.ha?.execution_topology !== 'shared-local' ||
      config.deployment.ha?.shared_filesystem !== true ||
      config.deployment.ha?.ingress_affinity !== true)
  ) {
    return { enabled: false, mode: 'disabled', reason: 'unsupported-ha-topology' };
  }
  return { enabled: true, mode: 'owner-local-ephemeral' };
}
