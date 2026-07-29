import type {
  AgenticToolConfigurationSource,
  DefaultAgenticToolConfig,
  GatewayAgenticConfig,
  PersistedGatewayAgenticConfig,
  ScheduleAgenticToolConfig,
} from '@agor/core/types';

const GATEWAY_NON_INLINE_FIELDS = new Set(['agent', 'presetId', 'envVars']);

export function scheduleAgenticToolConfigToSource(
  config: ScheduleAgenticToolConfig
): AgenticToolConfigurationSource {
  if (config.configuration_reference !== undefined) {
    return { reference: config.configuration_reference };
  }
  if (config.preset_id !== undefined) return { reference: config.preset_id };
  return {
    configuration: {
      modelConfig: config.model_config,
      permissionMode: config.permission_mode,
      codexSandboxMode: config.codex_sandbox_mode,
      codexApprovalPolicy: config.codex_approval_policy,
      codexNetworkAccess: config.codex_network_access,
    },
  };
}

export function hasDefinedGatewayAgenticConfigInlineFields(
  config: GatewayAgenticConfig | PersistedGatewayAgenticConfig | null | undefined
): boolean {
  return Object.entries(config ?? {}).some(
    ([key, value]) => !GATEWAY_NON_INLINE_FIELDS.has(key) && value !== undefined
  );
}

export function gatewayAgenticConfigToInlineConfiguration(
  config: GatewayAgenticConfig | PersistedGatewayAgenticConfig | null | undefined
): DefaultAgenticToolConfig {
  return {
    modelConfig: config?.modelConfig,
    permissionMode: config?.permissionMode,
    codexSandboxMode: config?.codexSandboxMode,
    codexApprovalPolicy: config?.codexApprovalPolicy,
    codexNetworkAccess: config?.codexNetworkAccess,
  };
}
