import {
  GATEWAY_REDACTED_SENTINEL,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  type GatewayChannel,
} from '../types/gateway';

/** Transport-safe projection for CRUD, realtime, and MCP gateway responses. */
export function redactGatewayChannelSecrets<T extends GatewayChannel>(channel: T): T {
  const config = { ...(channel.config ?? {}) };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (config[field] !== undefined) config[field] = GATEWAY_REDACTED_SENTINEL;
  }
  const agenticConfig = channel.agentic_config
    ? {
        ...channel.agentic_config,
        ...(channel.agentic_config.envVars
          ? {
              envVars: channel.agentic_config.envVars.map((value) => ({
                ...value,
                value: GATEWAY_REDACTED_SENTINEL,
              })),
            }
          : {}),
      }
    : channel.agentic_config;
  return {
    ...channel,
    channel_key: GATEWAY_REDACTED_SENTINEL,
    config,
    agentic_config: agenticConfig,
  };
}
