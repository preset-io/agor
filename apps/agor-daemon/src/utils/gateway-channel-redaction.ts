import type { GatewayChannel } from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL, GATEWAY_SENSITIVE_CONFIG_FIELDS } from '@agor/core/types';

/** Shared daemon transport projection for REST, realtime, and MCP channels. */
export function redactGatewayChannelForTransport(channel: GatewayChannel): GatewayChannel {
  const config = { ...(channel.config ?? {}) };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (Object.hasOwn(config, field)) config[field] = GATEWAY_REDACTED_SENTINEL;
  }

  const agentic_config = channel.agentic_config?.envVars
    ? {
        ...channel.agentic_config,
        envVars: channel.agentic_config.envVars.map((envVar) => ({
          ...envVar,
          value: GATEWAY_REDACTED_SENTINEL,
        })),
      }
    : channel.agentic_config;

  return {
    ...channel,
    channel_key: GATEWAY_REDACTED_SENTINEL,
    config,
    agentic_config,
  };
}
