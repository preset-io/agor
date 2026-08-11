import type { MaterializedAgenticToolConfiguration } from '@agor/core/config';
import type {
  AgenticToolConfigurationSource,
  DefaultAgenticToolConfig,
  GatewayAgenticConfig,
  PersistedGatewayAgenticConfig,
  PersistedScheduleAgenticToolConfig,
  ScheduleAgenticToolConfig,
} from '@agor/core/types';

const GATEWAY_NON_INLINE_FIELDS = new Set(['agent', 'presetId', 'envVars']);

export function scheduleAgenticToolConfigToSource(
  config: ScheduleAgenticToolConfig | PersistedScheduleAgenticToolConfig
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

export function materializedAgenticToolConfigurationToScheduleConfig(
  config: ScheduleAgenticToolConfig | PersistedScheduleAgenticToolConfig,
  materialized: MaterializedAgenticToolConfiguration
): PersistedScheduleAgenticToolConfig {
  return {
    agentic_tool: config.agentic_tool,
    ...(config.configuration_reference !== undefined
      ? { configuration_reference: config.configuration_reference }
      : config.preset_id !== undefined
        ? { preset_id: materialized.agentic_tool_preset_id ?? config.preset_id }
        : {}),
    ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
    permission_mode: materialized.permission_config.mode,
    ...(materialized.model_config ? { model_config: materialized.model_config } : {}),
    ...(materialized.permission_config.codex?.sandboxMode !== undefined
      ? { codex_sandbox_mode: materialized.permission_config.codex.sandboxMode }
      : {}),
    ...(materialized.permission_config.codex?.approvalPolicy !== undefined
      ? { codex_approval_policy: materialized.permission_config.codex.approvalPolicy }
      : {}),
    ...(materialized.permission_config.codex?.networkAccess !== undefined
      ? { codex_network_access: materialized.permission_config.codex.networkAccess }
      : {}),
  };
}

export function materializedAgenticToolConfigurationToGatewayConfig(
  config: GatewayAgenticConfig | PersistedGatewayAgenticConfig,
  materialized: MaterializedAgenticToolConfiguration
): PersistedGatewayAgenticConfig {
  return {
    agent: config.agent,
    ...(config.presetId !== undefined ? { presetId: config.presetId } : {}),
    ...(config.envVars !== undefined ? { envVars: config.envVars } : {}),
    permissionMode: materialized.permission_config.mode,
    ...(materialized.model_config ? { modelConfig: materialized.model_config } : {}),
    ...(materialized.permission_config.codex?.sandboxMode !== undefined
      ? { codexSandboxMode: materialized.permission_config.codex.sandboxMode }
      : {}),
    ...(materialized.permission_config.codex?.approvalPolicy !== undefined
      ? { codexApprovalPolicy: materialized.permission_config.codex.approvalPolicy }
      : {}),
    ...(materialized.permission_config.codex?.networkAccess !== undefined
      ? { codexNetworkAccess: materialized.permission_config.codex.networkAccess }
      : {}),
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
