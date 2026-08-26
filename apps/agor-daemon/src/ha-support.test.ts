import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertHaTaskPermissionSupported,
  HA_UNSUPPORTED_FEATURES,
  hasClaudeSubscriptionOAuthCapability,
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
      completionCallbackDurableAdmission: true as const,
      completionCallbackPreAdmissionRecovery: false as const,
      widgetResolutionDurableClaim: true as const,
      githubInstall: true as const,
      codexCredentialFiles: true,
      codexDeviceAuth: true,
      claudeAuth: true,
      claudeOAuth: true,
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
      'mcpOAuth',
      'codexAuth',
      'codexDeviceAuth',
      'claudeAuth',
      'claudeOAuth',
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

  it('admits Claude only with its exact-user generation-fenced HA capabilities', () => {
    expect(isHaFeatureUnavailable(ha, 'claudeAuth')).toBe(false);
    expect(isHaFeatureUnavailable(ha, 'claudeOAuth')).toBe(false);
    expect(
      isHaFeatureUnavailable(
        { ...ha, capabilities: { ...ha.capabilities, claudeAuth: false } },
        'claudeAuth'
      )
    ).toBe(true);
    expect(
      isHaFeatureUnavailable(
        { ...ha, capabilities: { ...ha.capabilities, claudeOAuth: false } },
        'claudeOAuth'
      )
    ).toBe(true);
  });

  it('does not mistake the immutable runtime authority layout for HA mutation ownership', () => {
    const containedWithoutDurableAuthority = {
      ...ha,
      capabilities: { ...ha.capabilities, claudeAuth: false, claudeOAuth: false },
    };
    expect(
      hasClaudeSubscriptionOAuthCapability(
        {
          agentic_tools: { claude_subscription_oauth: true },
          execution: {
            unix_user_mode: 'sandbox',
            executor_storage: {
              user_home: 'persistent-per-user',
              user_home_locking: 'cross-replica-flock',
            },
            sandbox: { enabled: true, home_mode: 'per_user' },
          },
        },
        containedWithoutDurableAuthority
      )
    ).toBe(false);
    expect(isHaFeatureUnavailable(containedWithoutDurableAuthority, 'claudeAuth')).toBe(true);
    expect(isHaFeatureUnavailable(containedWithoutDurableAuthority, 'claudeOAuth')).toBe(true);
  });

  it('requires operator authorization and topology support for the Claude OAuth capability', () => {
    const standalone = { mode: 'standalone' as const };
    const authorizedContained = {
      agentic_tools: { claude_subscription_oauth: true },
      execution: {
        unix_user_mode: 'sandbox' as const,
        executor_storage: { user_home: 'persistent-per-user' as const },
        sandbox: { enabled: true, home_mode: 'per_user' as const },
      },
    };
    expect(hasClaudeSubscriptionOAuthCapability({}, standalone)).toBe(false);
    expect(hasClaudeSubscriptionOAuthCapability(authorizedContained, standalone)).toBe(true);
    expect(hasClaudeSubscriptionOAuthCapability(authorizedContained, ha)).toBe(true);
    expect(hasClaudeSubscriptionOAuthCapability({}, ha)).toBe(false);
    const writableEscape = {
      ...authorizedContained,
      execution: {
        ...authorizedContained.execution,
        sandbox: {
          ...authorizedContained.execution.sandbox,
          extra_allow_write: ['/home/agor/.agor'],
        },
      },
    };
    // An extra writable bind can re-expose an initially hidden physical owner
    // store after alias analysis. Reject every such topology rather than
    // advertising a containment guarantee that depends on path coincidence.
    expect(hasClaudeSubscriptionOAuthCapability(writableEscape, standalone)).toBe(false);
    expect(hasClaudeSubscriptionOAuthCapability(writableEscape, ha)).toBe(false);
    expect(
      hasClaudeSubscriptionOAuthCapability(authorizedContained, {
        ...ha,
        capabilities: { ...ha.capabilities, claudeOAuth: false },
      })
    ).toBe(false);
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
