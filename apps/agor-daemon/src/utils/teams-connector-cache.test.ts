import type { GatewayChannel } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TeamsConnectorCache, type TeamsSendConnector } from './teams-connector-cache.js';

function channel(overrides: Record<string, unknown> = {}, generation = 3): GatewayChannel {
  return {
    id: 'channel-1',
    channel_type: 'teams',
    provider_config_generation: generation,
    config: {
      app_id: 'teams-app',
      app_password: 'secret-a',
      microsoft_tenant_id: 'entra-1',
      ...overrides,
    },
  } as unknown as GatewayChannel;
}

function cache() {
  const factory = vi.fn(
    (config: Record<string, unknown>) =>
      ({
        config,
        prepareSend: vi.fn(),
        invalidateTokens: vi.fn(),
        formatMessage: (t: string) => t,
      }) as unknown as TeamsSendConnector
  );
  return { connectors: new TeamsConnectorCache(factory), factory };
}

describe('TeamsConnectorCache', () => {
  it('reuses one connector per tenant, channel, generation, and credential', () => {
    const { connectors, factory } = cache();
    expect(connectors.get('tenant-a', channel())).toBe(connectors.get('tenant-a', channel()));
    expect(factory).toHaveBeenCalledOnce();
  });

  it('never hands one tenant a connector built from another tenant with the same channel id', () => {
    const { connectors } = cache();
    const tenantA = connectors.get('tenant-a', channel({ app_password: 'secret-a' }));
    const tenantB = connectors.get('tenant-b', channel({ app_password: 'secret-b' }));
    expect(tenantB).not.toBe(tenantA);
    expect((tenantB as unknown as { config: { app_password: string } }).config.app_password).toBe(
      'secret-b'
    );
  });

  it('rebuilds after a credential-only secret rotation or a generation change', () => {
    const { connectors } = cache();
    const before = connectors.get('tenant-a', channel());
    expect(connectors.get('tenant-a', channel({ app_password: 'rotated' }))).not.toBe(before);
    expect(connectors.get('tenant-a', channel({}, 4))).not.toBe(before);
  });

  it('refuses a lookup without tenant identity', () => {
    const { connectors } = cache();
    expect(() => connectors.get(undefined, channel())).toThrow('tenant identity');
  });
});
