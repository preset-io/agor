import type { ResolvedDeploymentConfig } from '@agor/core/config';
import { Unavailable } from '@agor/core/feathers';
import type { HookContext, PermissionMode, Session } from '@agor/core/types';
import { mapPermissionMode } from '@agor/core/utils/permission-mode-mapper';

export const HA_CONSTRAINED_PROFILE = 'constrained-active-active' as const;

export const HA_UNSUPPORTED_FEATURES = {
  interactivePermissions: 'interactive permission modes without durable decision replay',
  mcpOAuth: 'MCP OAuth flows',
  githubInstall: 'GitHub App installation state',
  codexAuth: 'Codex credential-file import/logout without a consistent executor user home',
  codexDeviceAuth: 'Codex device authentication polling without durable attempt ownership',
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
  return true;
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

/**
 * Initial HA execution admits only modes that cannot create an Agor permission
 * waiter. Permission Messages are durable, but an executor that reconnects
 * after the decision still has no durable read-after-gap/replay protocol.
 */
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
  if (isConstrainedHa(deployment) && !isHaNonInteractivePermission(options)) {
    throw haUnavailable('interactivePermissions');
  }
}
