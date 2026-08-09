import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertHaTaskPermissionSupported,
  HA_UNSUPPORTED_FEATURES,
  haUnavailable,
  isHaFeatureUnavailable,
  isHaNonInteractivePermission,
  rejectInConstrainedHa,
} from './ha-support.js';

describe('constrained HA support profile', () => {
  const ha = {
    mode: 'ha' as const,
    supportProfile: 'constrained-active-active' as const,
    capabilities: {
      taskExecution: true as const,
      executorTokenAuthority: true as const,
      interactivePermissions: false as const,
      scheduler: true as const,
      sessionQueue: true as const,
      taskRuntimeReconciliation: true as const,
      knowledgeEmbeddingIndexer: true as const,
      statelessMcp: true as const,
      completionCallbackDurableAdmission: true as const,
      completionCallbackPreAdmissionRecovery: false as const,
      widgetResolutionDurableClaim: true as const,
      codexCredentialFiles: true,
      codexDeviceAuth: false as const,
      processAffineAuth: false as const,
      gatewayListeners: true as const,
      gatewayOutboundExactlyOnce: false as const,
      environmentHealthMonitor: true as const,
      artifactRuntimeIntrospection: false as const,
    },
    redis: {} as never,
    environmentHealthMonitor: {} as never,
    executorStorage: {
      userHome: 'shared' as const,
      branchWorkspace: 'shared' as const,
      baseRepository: 'shared' as const,
    },
    topology: {
      execution: 'shared-local' as const,
      sharedFilesystem: true as const,
      ingressAffinity: true as const,
    },
  };

  it('fails interactive permissions with an explicit stable feature code', () => {
    expect(() => rejectInConstrainedHa(ha, 'interactivePermissions')({} as HookContext)).toThrow(
      /durable decision replay/
    );
    expect(haUnavailable('interactivePermissions').data).toMatchObject({
      code: 'HA_FEATURE_UNSUPPORTED',
      feature: 'interactivePermissions',
      support_profile: 'constrained-active-active',
    });
  });

  it.each([
    ['claude-code', { mode: 'bypassPermissions' }],
    ['codex', { mode: 'allow-all', codex: { approvalPolicy: 'never' } }],
    ['gemini', { mode: 'yolo' }],
    ['copilot', { mode: 'bypassPermissions' }],
    ['cursor', { mode: 'default' }],
  ] as const)('admits noninteractive %s execution', (agenticTool, permission_config) => {
    expect(
      isHaNonInteractivePermission({
        session: { agentic_tool: agenticTool, permission_config } as never,
      })
    ).toBe(true);
  });

  it('rejects a mode that can create a process-local permission waiter', () => {
    expect(() =>
      assertHaTaskPermissionSupported(ha, {
        session: { agentic_tool: 'claude-code', permission_config: { mode: 'auto' } } as never,
      })
    ).toThrow(/interactive permission modes/);
  });

  it.each([
    ['claude-code', { mode: 'dontAsk' }],
    ['opencode', { mode: 'bypassPermissions' }],
    ['codex', { mode: 'allow-all', codex: { approvalPolicy: 'on-request' } }],
  ] as const)(
    'rejects %s configurations that retain an interactive path',
    (agenticTool, permission_config) => {
      expect(
        isHaNonInteractivePermission({
          session: { agentic_tool: agenticTool, permission_config } as never,
        })
      ).toBe(false);
    }
  );

  it('keeps the audited process-affine inventory explicit', () => {
    expect(Object.keys(HA_UNSUPPORTED_FEATURES)).toEqual([
      'interactivePermissions',
      'mcpOAuth',
      'githubInstall',
      'codexAuth',
      'codexDeviceAuth',
      'openCodeAuth',
      'artifactRuntime',
    ]);
  });

  it('admits Codex auth-file operations only with a consistent executor home', () => {
    expect(isHaFeatureUnavailable(ha, 'codexAuth')).toBe(false);
    expect(
      isHaFeatureUnavailable(
        {
          ...ha,
          capabilities: { ...ha.capabilities, codexCredentialFiles: false },
        },
        'codexAuth'
      )
    ).toBe(true);
    expect(isHaFeatureUnavailable(ha, 'codexDeviceAuth')).toBe(true);
  });

  it('does not change standalone behavior', () => {
    const context = {} as HookContext;
    expect(rejectInConstrainedHa({ mode: 'standalone' }, 'interactivePermissions')(context)).toBe(
      context
    );
  });
});
