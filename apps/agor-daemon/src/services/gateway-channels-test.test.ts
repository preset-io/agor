import type { GatewayChannel, HookContext, SlackTestResult } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORED_BOT_TOKEN = 'xoxb-decrypted-secret';
const STORED_APP_TOKEN = 'xapp-decrypted-secret';

// Capture the config the connector was built with so we can assert that the
// decrypted stored tokens (not the redaction sentinel) reached the probe.
let capturedConfig: Record<string, unknown> | undefined;
let probeResult: SlackTestResult;

const findById = vi.fn();

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    GatewayChannelRepository: class {
      findById = findById;
    },
  };
});

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: (_channelType: string, config: Record<string, unknown>) => {
      capturedConfig = config;
      return { testConnection: async () => probeResult };
    },
  };
});

const { createGatewayChannelsTestService } = await import('./gateway-channels-test.js');
const { requireMinimumRole } = await import('../utils/authorization.js');

const storedChannel: GatewayChannel = {
  id: 'chan-1',
  name: 'Slack',
  channel_type: 'slack',
  channel_key: 'key',
  enabled: true,
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  config: {
    bot_token: STORED_BOT_TOKEN,
    app_token: STORED_APP_TOKEN,
    allowed_channel_ids: ['C1'],
  },
  agentic_config: null,
  created_by: 'user-1',
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

beforeEach(() => {
  capturedConfig = undefined;
  findById.mockReset();
  probeResult = {
    ok: true,
    team: { id: 'T1', name: 'Acme' },
    bot: { userId: 'U1', name: 'agor-bot' },
    appTokenValid: true,
    channelAccess: [{ channelId: 'C1', ok: true }],
    failures: [],
    notVerifiable: ['something'],
  };
});

describe('gateway-channels/test admin gate', () => {
  const gate = requireMinimumRole(ROLES.ADMIN, 'test gateway channels');

  it('rejects a non-admin caller', () => {
    const context = {
      params: { provider: 'rest', user: { user_id: 'u', role: ROLES.MEMBER } },
    } as unknown as HookContext;
    expect(() => gate(context)).toThrow();
  });

  it('allows an admin caller', () => {
    const context = {
      params: { provider: 'rest', user: { user_id: 'u', role: ROLES.ADMIN } },
    } as unknown as HookContext;
    expect(() => gate(context)).not.toThrow();
  });
});

describe('gateway-channels/test service', () => {
  it('substitutes decrypted stored tokens when only gatewayChannelId is given', async () => {
    findById.mockResolvedValue(storedChannel);
    const service = createGatewayChannelsTestService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });

    expect(findById).toHaveBeenCalledWith('chan-1');
    expect(capturedConfig?.bot_token).toBe(STORED_BOT_TOKEN);
    expect(capturedConfig?.app_token).toBe(STORED_APP_TOKEN);
    expect(result.ok).toBe(true);
  });

  it('keeps stored secrets when overrides send the redaction sentinel', async () => {
    findById.mockResolvedValue(storedChannel);
    const service = createGatewayChannelsTestService({} as never);

    await service.create({
      gatewayChannelId: 'chan-1',
      config: { bot_token: '••••••••', allowed_channel_ids: ['C2'] },
    });

    expect(capturedConfig?.bot_token).toBe(STORED_BOT_TOKEN);
    // A real (non-sentinel) override is applied.
    expect(capturedConfig?.allowed_channel_ids).toEqual(['C2']);
  });

  it('returns a result free of any token strings', async () => {
    findById.mockResolvedValue(storedChannel);
    const service = createGatewayChannelsTestService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(STORED_BOT_TOKEN);
    expect(serialized).not.toContain(STORED_APP_TOKEN);
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain('xapp');
  });
});
