import type { GatewayProviderProbeLease } from '@agor/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCORD_PROVIDER_PROBE_RENEW_INTERVAL_MS,
  DISCORD_PROVIDER_PROBE_RENEW_TIMEOUT_MS,
  GatewayProviderProbeHeartbeat,
} from './gateway-provider-probe-heartbeat.js';

const lease = {
  channel_id: '01927f9d-1000-7000-8000-000000000001',
  claim_token: 'probe-token',
  generation: 7,
  provider_config_generation: 11,
  lease_expires_at: '2099-01-01T00:00:00.000Z',
} as GatewayProviderProbeLease;

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayProviderProbeHeartbeat', () => {
  it('renews with every exact durable fence and never consults process wall time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2200-01-01T00:00:00.000Z');
    const renewProviderProbe = vi.fn(async () => lease);
    const heartbeat = new GatewayProviderProbeHeartbeat({ renewProviderProbe }, lease);

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(DISCORD_PROVIDER_PROBE_RENEW_INTERVAL_MS);

    expect(renewProviderProbe).toHaveBeenCalledWith({
      channelId: lease.channel_id,
      claimToken: lease.claim_token,
      generation: lease.generation,
      providerConfigGeneration: lease.provider_config_generation,
      leaseDurationMs: 30_000,
    });
    expect(heartbeat.signal.aborted).toBe(false);
    await heartbeat.stop();
  });

  it('fails closed before the lease can expire when a DB renewal stalls', async () => {
    vi.useFakeTimers();
    const renewProviderProbe = vi.fn(
      () => new Promise<GatewayProviderProbeLease | null>(() => undefined)
    );
    const heartbeat = new GatewayProviderProbeHeartbeat({ renewProviderProbe }, lease);

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(
      DISCORD_PROVIDER_PROBE_RENEW_INTERVAL_MS + DISCORD_PROVIDER_PROBE_RENEW_TIMEOUT_MS
    );

    expect(renewProviderProbe).toHaveBeenCalledOnce();
    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.abortCode()).toBe('probe_ownership_lost');
    await heartbeat.stop();
  });
});
