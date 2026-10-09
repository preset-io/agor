import { createHash } from 'node:crypto';
import { getConnector, type TeamsConnector } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';

/** The Teams connector surface outbound sends need. */
export type TeamsSendConnector = Pick<
  TeamsConnector,
  'prepareSend' | 'formatMessage' | 'invalidateTokens' | 'downloadToken'
>;

const MAX_CACHED_CONNECTORS = 256;

/**
 * Key a connector by trusted tenant, channel, config generation, and the
 * credential it holds. A credential-only secret rotation keeps the generation,
 * so the secret digest is part of the key.
 */
export function teamsConnectorCacheKey(tenantId: string, channel: GatewayChannel): string {
  const config = channel.config as Record<string, unknown>;
  const secret = typeof config.app_password === 'string' ? config.app_password : '';
  return JSON.stringify([
    tenantId,
    channel.id,
    channel.provider_config_generation,
    typeof config.app_id === 'string' ? config.app_id : '',
    typeof config.microsoft_tenant_id === 'string' ? config.microsoft_tenant_id : '',
    createHash('sha256').update(secret).digest('base64url'),
  ]);
}

/** Bounded LRU of Teams connectors; never shared across tenants, channels, or credentials. */
export class TeamsConnectorCache {
  private readonly entries = new Map<string, TeamsSendConnector>();

  constructor(
    private readonly factory: (config: Record<string, unknown>) => TeamsSendConnector = (config) =>
      getConnector('teams', config) as unknown as TeamsSendConnector
  ) {}

  get(tenantId: string | undefined, channel: GatewayChannel): TeamsSendConnector {
    if (!tenantId) throw new Error('Teams connector lookup requires tenant identity');
    const key = teamsConnectorCacheKey(tenantId, channel);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const created = this.factory(channel.config as Record<string, unknown>);
    this.entries.set(key, created);
    while (this.entries.size > MAX_CACHED_CONNECTORS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return created;
  }
}

/** Process-wide cache shared by the delivery worker and best-effort notices. */
export const teamsConnectorCache = new TeamsConnectorCache();
