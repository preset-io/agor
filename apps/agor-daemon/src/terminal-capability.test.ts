import type { AgorConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import { resolveWebTerminalCapability } from './terminal-capability';

describe('resolveWebTerminalCapability', () => {
  it('supports owner-local standalone and shared-local HA runtimes', () => {
    expect(resolveWebTerminalCapability({} as AgorConfig)).toMatchObject({
      enabled: true,
      mode: 'owner-local-ephemeral',
    });
    expect(
      resolveWebTerminalCapability({
        deployment: {
          mode: 'ha',
          ha: {
            execution_topology: 'shared-local',
            shared_filesystem: true,
            ingress_affinity: true,
          },
        },
      } as AgorConfig)
    ).toMatchObject({ enabled: true, mode: 'owner-local-ephemeral' });
  });

  it('fails closed for operator-disabled and unowned external runtimes', () => {
    expect(
      resolveWebTerminalCapability({
        execution: { allow_web_terminal: false },
      } as AgorConfig)
    ).toMatchObject({ enabled: false, reason: 'operator-disabled' });
    expect(
      resolveWebTerminalCapability({
        execution: { executor_command_template: 'kubectl create -f -' },
      } as AgorConfig)
    ).toMatchObject({ enabled: false, reason: 'external-runtime-unowned' });
    expect(
      resolveWebTerminalCapability({
        deployment: {
          mode: 'ha',
          ha: {
            execution_topology: 'shared-local',
            shared_filesystem: true,
            ingress_affinity: false,
          },
        },
      } as AgorConfig)
    ).toMatchObject({ enabled: false, reason: 'unsupported-ha-topology' });
  });
});
