import { describe, expect, it } from 'vitest';
import { ensureOpenSourceTelemetryEnvEnabledConfig } from './open-source-telemetry-config.js';

describe('open-source telemetry daemon config', () => {
  it('creates an anonymous instance id when AGOR_TELEMETRY=1 forces telemetry on', () => {
    const result = ensureOpenSourceTelemetryEnvEnabledConfig(
      { telemetry: { enabled: false } },
      { AGOR_TELEMETRY: '1' } as NodeJS.ProcessEnv,
      () => 'instance-1'
    );

    expect(result).toEqual({
      changed: true,
      config: {
        telemetry: {
          enabled: true,
          instance_id: 'instance-1',
        },
      },
    });
  });

  it('does not create an instance id when telemetry is disabled by env', () => {
    const result = ensureOpenSourceTelemetryEnvEnabledConfig(
      { telemetry: { enabled: true } },
      { AGOR_TELEMETRY: '0' } as NodeJS.ProcessEnv,
      () => 'instance-1'
    );

    expect(result).toEqual({
      changed: false,
      config: { telemetry: { enabled: true } },
    });
  });
});
