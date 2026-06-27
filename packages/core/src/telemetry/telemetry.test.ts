import { describe, expect, it, vi } from 'vitest';
import {
  BatchedOpenSourceTelemetryLogger,
  generateTelemetryInstanceId,
  isTelemetryEnabledByEnv,
  isTelemetryFullyDisabledByEnv,
  normalizeTelemetryModelFamily,
  normalizeTelemetryProvider,
  resolveOpenSourceTelemetryConfig,
  sanitizeTelemetryProperties,
} from './index.js';
import type { OpenSourceTelemetryTransport, SegmentBatchPayload } from './types.js';

class CaptureTransport implements OpenSourceTelemetryTransport {
  batches: SegmentBatchPayload[] = [];
  async send(batch: SegmentBatchPayload): Promise<void> {
    this.batches.push(batch);
  }
}

describe('open-source telemetry config', () => {
  it('honors kill-switch environment variables', () => {
    expect(isTelemetryFullyDisabledByEnv({ DO_NOT_TRACK: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTelemetryFullyDisabledByEnv({ AGOR_TELEMETRY: '0' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTelemetryEnabledByEnv({ AGOR_TELEMETRY: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isTelemetryEnabledByEnv({
        AGOR_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('allows environment to enable telemetry over config', () => {
    const resolved = resolveOpenSourceTelemetryConfig({
      env: { AGOR_TELEMETRY: '1', AGOR_TELEMETRY_WRITE_KEY: 'wk' } as NodeJS.ProcessEnv,
      config: { telemetry: { enabled: false, instance_id: 'instance-1' } },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.writeKey).toBe('wk');
  });

  it('generates random instance ids', () => {
    expect(generateTelemetryInstanceId()).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('open-source telemetry payload hygiene', () => {
  it('drops sensitive-looking properties recursively', () => {
    const clean = sanitizeTelemetryProperties({
      prompt: 'secret prompt',
      branch_id: 'branch-1',
      active_user_count: 2,
      nested: { user_id: 'user-1', prompt_count: 3 },
    });

    expect(clean).toEqual({
      active_user_count: 2,
      nested: { prompt_count: 3 },
    });
  });

  it('normalizes providers and model families without preserving custom names', () => {
    expect(normalizeTelemetryProvider('Gemini')).toBe('google');
    expect(normalizeTelemetryProvider('AcmeInternal')).toBe('other');
    expect(normalizeTelemetryModelFamily('claude-sonnet-4-5')).toBe('claude-sonnet');
    expect(normalizeTelemetryModelFamily('acme-prod-secure-westus')).toBe('custom');
  });

  it('emits Segment-compatible anonymous batches', async () => {
    vi.useFakeTimers();
    const transport = new CaptureTransport();
    const logger = new BatchedOpenSourceTelemetryLogger(
      {
        enabled: true,
        instanceId: 'instance-1',
        endpoint: 'https://example.com/batch',
        writeKey: null,
        debug: false,
        timeoutMs: 1000,
        flushIntervalMs: 10,
        maxBatchSize: 10,
      },
      transport
    );

    logger.track({ event: 'install.completed', properties: { ongoing_telemetry_enabled: true } });
    await logger.flush();

    expect(transport.batches).toHaveLength(1);
    expect(transport.batches[0].batch[0]).toMatchObject({
      type: 'track',
      event: 'install.completed',
      anonymousId: 'instance-1',
      properties: { ongoing_telemetry_enabled: true },
    });
    vi.useRealTimers();
  });
});
