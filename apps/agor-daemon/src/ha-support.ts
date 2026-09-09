import {
  type AgorConfig,
  hasContainedClaudeRuntimeCredentials,
  isClaudeSubscriptionOAuthEnabled,
  type ResolvedDeploymentConfig,
} from '@agor/core/config';
import { Unavailable } from '@agor/core/feathers';
import type { HookContext, PermissionMode, Session } from '@agor/core/types';
import { mapPermissionMode } from '@agor/core/utils/permission-mode-mapper';

export const HA_CONSTRAINED_PROFILE = 'constrained-active-active' as const;

export const HA_UNSUPPORTED_FEATURES = {
  providerNativeInteractivePermissions:
    'provider-native interactive permission modes without Agor realtime decision routing',
  codexAuth:
    'Codex credential-file import/logout without a consistent executor user home and execution.executor_storage.user_home_locking: cross-replica-flock',
  codexDeviceAuth:
    'Codex device authentication without durable attempt ownership, exact per-user credential routing, and execution.executor_storage.user_home_locking: cross-replica-flock',
  claudeAuth:
    'Claude credential mutation without exact local per-user routing, cross-replica writer serialization, and generation fencing',
  claudeOAuth:
    'Claude subscription OAuth without durable attempt ownership, exact per-user routing, cross-replica credential mutation authority, and concrete runtime credential containment',
  openCodeAuth: 'OpenCode OAuth/native authentication flows',
  artifactRuntime: 'synchronous artifact runtime introspection',
} as const;

export type HaUnsupportedFeature = keyof typeof HA_UNSUPPORTED_FEATURES;

export function isConstrainedHa(
  deployment: ResolvedDeploymentConfig
): deployment is Extract<ResolvedDeploymentConfig, { mode: 'ha' }> {
  return deployment.mode === 'ha';
}

export function haUnavailable(feature: HaUnsupportedFeature): Unavailable {
  return new Unavailable(
    `HA support profile ${HA_CONSTRAINED_PROFILE} does not support ${HA_UNSUPPORTED_FEATURES[feature]}`,
    { code: 'HA_FEATURE_UNSUPPORTED', feature, support_profile: HA_CONSTRAINED_PROFILE }
  );
}

export function isHaFeatureUnavailable(
  deployment: ResolvedDeploymentConfig,
  feature: HaUnsupportedFeature
): boolean {
  if (!isConstrainedHa(deployment)) return false;
  if (feature === 'codexAuth') return !deployment.capabilities.codexCredentialFiles;
  if (feature === 'codexDeviceAuth') return !deployment.capabilities.codexDeviceAuth;
  if (feature === 'claudeAuth') return !deployment.capabilities.claudeAuth;
  if (feature === 'claudeOAuth') return !deployment.capabilities.claudeOAuth;
  return true;
}

/** Effective UI/runtime capability: provider authorization AND topology support. */
export function hasClaudeSubscriptionOAuthCapability(
  config: AgorConfig,
  deployment: ResolvedDeploymentConfig
): boolean {
  return (
    isClaudeSubscriptionOAuthEnabled(config) &&
    hasContainedClaudeRuntimeCredentials(config) &&
    !isHaFeatureUnavailable(deployment, 'claudeOAuth')
  );
}

export function rejectInConstrainedHa(
  deployment: ResolvedDeploymentConfig,
  feature: HaUnsupportedFeature
): (context: HookContext) => HookContext {
  return (context) => {
    if (isHaFeatureUnavailable(deployment, feature)) throw haUnavailable(feature);
    return context;
  };
}

/** Identify modes that cannot create either an Agor or provider-native prompt. */
export function isHaNonInteractivePermission(options: {
  session: Pick<Session, 'agentic_tool' | 'permission_config'>;
  requestedMode?: PermissionMode;
}): boolean {
  const { session, requestedMode } = options;
  const mode = requestedMode ?? session.permission_config?.mode;
  switch (session.agentic_tool) {
    case 'claude-code':
      // Only bypassPermissions omits Agor's canUseTool callback entirely.
      return mode === 'bypassPermissions';
    case 'copilot':
      return mode === 'bypassPermissions' || mode === 'allow-all';
    case 'cursor':
      // The current Cursor SDK surface is autonomous and does not register an
      // Agor permission callback regardless of the persisted display mode.
      return true;
    case 'gemini':
      return mapPermissionMode(mode ?? 'default', 'gemini') === 'yolo';
    case 'opencode':
      // Even bypass/yolo still routes OpenCode `question` and `task`
      // permission effects through Agor's process-local permission manager.
      return false;
    case 'codex':
      if (session.permission_config?.codex?.approvalPolicy !== undefined) {
        return session.permission_config.codex.approvalPolicy === 'never';
      }
      return mapPermissionMode(mode ?? 'ask', 'codex') === 'allow-all';
    default:
      return false;
  }
}

export function assertHaTaskPermissionSupported(
  deployment: ResolvedDeploymentConfig,
  options: Parameters<typeof isHaNonInteractivePermission>[0]
): void {
  // Claude, Copilot, and OpenCode route their interactive callback through the
  // executor's Agor PermissionService. The task-scoped Feathers control room
  // can deliver those decisions across replicas while the executor remains
  // alive. Gemini and Codex still rely on provider-native confirmation
  // surfaces that Agor does not answer, so retain their noninteractive gate.
  const hasAgorRealtimeDecisionHandler =
    options.session.agentic_tool === 'claude-code' ||
    options.session.agentic_tool === 'copilot' ||
    options.session.agentic_tool === 'opencode';
  if (
    isConstrainedHa(deployment) &&
    !hasAgorRealtimeDecisionHandler &&
    !isHaNonInteractivePermission(options)
  ) {
    throw haUnavailable('providerNativeInteractivePermissions');
  }
}
