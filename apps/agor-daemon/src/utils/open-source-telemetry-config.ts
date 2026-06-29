import type { AgorConfig } from '@agor/core/config';
import { generateTelemetryInstanceId, isTelemetryEnabledByEnv } from '@agor/core/telemetry';

export function ensureOpenSourceTelemetryEnvEnabledConfig(
  config: AgorConfig,
  env: NodeJS.ProcessEnv = process.env,
  generateInstanceId: () => string = generateTelemetryInstanceId
): { config: AgorConfig; changed: boolean } {
  if (!isTelemetryEnabledByEnv(env) || config.telemetry?.instance_id) {
    return { config, changed: false };
  }

  return {
    config: {
      ...config,
      telemetry: {
        ...config.telemetry,
        enabled: true,
        instance_id: generateInstanceId(),
      },
    },
    changed: true,
  };
}
