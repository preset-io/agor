import { describe, expect, it } from 'vitest';
import type { GatewayChannel } from '../types';
import { redactGatewayChannelSecrets } from './redaction';

describe('redactGatewayChannelSecrets', () => {
  it('removes channel capabilities without mutating the repository row', () => {
    const canary = 'GATEWAY_SECRET_CANARY';
    const channel = {
      channel_key: `${canary}_KEY`,
      config: { bot_token: `${canary}_TOKEN`, allowed_channel_ids: ['C1'] },
      agentic_config: {
        envVars: [{ key: 'TOKEN', value: `${canary}_ENV`, forceOverride: true }],
      },
    } as unknown as GatewayChannel;

    const result = redactGatewayChannelSecrets(channel);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.config.allowed_channel_ids).toEqual(['C1']);
    expect(channel.channel_key).toContain(canary);
    expect(channel.config.bot_token).toContain(canary);
  });
});
