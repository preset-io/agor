import type { GatewayChannel, HookContext } from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { redactGatewayChannelResultsForTransport } from './register-hooks';

const channel = (): GatewayChannel =>
  ({
    id: 'channel-1',
    created_by: 'user-1',
    name: 'Discord',
    channel_type: 'discord',
    target_branch_id: 'branch-1',
    agor_user_id: null,
    provider_installation_id: 'installation-1',
    provider_config_generation: 1,
    channel_key: 'inbound-secret',
    config: { bot_token: 'bot-secret', guild_id: 'guild-1' },
    agentic_config: {
      envVars: [{ key: 'SECRET', value: 'env-secret', forceOverride: false }],
    },
    enabled: true,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    last_message_at: null,
  }) as unknown as GatewayChannel;

describe('gateway channel REST/realtime projection', () => {
  it('redacts channel_key in result and dispatch, including paginated results', () => {
    const result = { total: 1, data: [channel()] };
    const context = { result } as unknown as HookContext;

    redactGatewayChannelResultsForTransport(context);

    expect(result.data[0].channel_key).toBe(GATEWAY_REDACTED_SENTINEL);
    expect(result.data[0].config.bot_token).toBe(GATEWAY_REDACTED_SENTINEL);
    expect(result.data[0].agentic_config?.envVars?.[0].value).toBe(GATEWAY_REDACTED_SENTINEL);
    expect(context.dispatch).toBe(context.result);
    expect(JSON.stringify(context.dispatch)).not.toContain('inbound-secret');
  });
});
