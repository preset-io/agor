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
      agorManagedInteractivePermissions: true as const,
      scheduler: true as const,
      sessionQueue: true as const,
      taskRuntimeReconciliation: true as const,
      knowledgeEmbeddingIndexer: true as const,
      statelessMcp: true as const,
      mcpOAuth: true as const,
      completionCallbackDurableAdmission: true as const,
      completionCallbackPreAdmissionRecovery: false as const,
      widgetResolutionDurableClaim: true as const,
      githubInstall: true as const,
      codexCredentialFiles: true,
      codexDeviceAuth: true,
      processAffineAuth: false as const,
      gatewayListeners: true as const,
      gatewayOutboundExactlyOnce: false as const,
      environmentHealthMonitor: true as const,
      artifactRuntimeIntrospection: false as const,
    },
    redis: {} as never,
    environmentHealthMonitor: {} as never,
    executorStorage: {
      userHome: 'persistent-per-user' as const,
      branchWorkspace: 'shared' as const,
      baseRepository: 'shared' as const,
    },
    topology: {
      execution: 'shared-local' as const,
      sharedFilesystem: true as const,
      ingressAffinity: true as const,
    },
  };

  it('keeps unsupported provider-native prompts behind an explicit stable feature code', () => {
    expect(() =>
      rejectInConstrainedHa(ha, 'providerNativeInteractivePermissions')({} as HookContext)
    ).toThrow(/provider-native interactive permission modes/);
    expect(haUnavailable('providerNativeInteractivePermissions').data).toMatchObject({
      code: 'HA_FEATURE_UNSUPPORTED',
      feature: 'providerNativeInteractivePermissions',
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

  it.each(['claude-code', 'copilot', 'opencode'] as const)(
    'admits %s interactive execution through the task-private realtime route',
    (agenticTool) => {
      expect(() =>
        assertHaTaskPermissionSupported(ha, {
          session: { agentic_tool: agenticTool, permission_config: { mode: 'ask' } } as never,
        })
      ).not.toThrow();
    }
  );

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

  it.each([
    ['gemini', { mode: 'default' }],
    ['codex', { mode: 'allow-all', codex: { approvalPolicy: 'on-request' } }],
  ] as const)(
    'still rejects provider-native %s confirmation modes',
    (agenticTool, permission_config) => {
      expect(() =>
        assertHaTaskPermissionSupported(ha, {
          session: { agentic_tool: agenticTool, permission_config } as never,
        })
      ).toThrow(/provider-native interactive permission modes/);
    }
  );

  it('keeps the audited process-affine inventory explicit', () => {
    expect(Object.keys(HA_UNSUPPORTED_FEATURES)).toEqual([
      'providerNativeInteractivePermissions',
      'codexAuth',
      'codexDeviceAuth',
      'openCodeAuth',
      'artifactRuntime',
    ]);
  });

  it('admits Codex auth-file operations with a consistent home and device auth only when exact-user routed', () => {
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
    expect(isHaFeatureUnavailable(ha, 'codexDeviceAuth')).toBe(false);
    expect(
      isHaFeatureUnavailable(
        {
          ...ha,
          capabilities: { ...ha.capabilities, codexDeviceAuth: false },
        },
        'codexDeviceAuth'
      )
    ).toBe(true);
  });

  it('gives gated Codex routes actionable cross-replica lock guidance', () => {
    expect(haUnavailable('codexAuth').message).toContain(
      'execution.executor_storage.user_home_locking: cross-replica-flock'
    );
    expect(haUnavailable('codexDeviceAuth').message).toContain(
      'execution.executor_storage.user_home_locking: cross-replica-flock'
    );
  });

  it('does not change standalone behavior', () => {
    const context = {} as HookContext;
    expect(
      rejectInConstrainedHa({ mode: 'standalone' }, 'providerNativeInteractivePermissions')(context)
    ).toBe(context);
  });
});
