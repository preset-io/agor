import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayChannel, HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORED_BOT_TOKEN = 'xoxb-decrypted-secret';

// Resolved token the service fed into the REAL connector, proving the
// decrypted stored token reaches the app-info probe end-to-end.
let capturedBotToken: string | undefined;
let authTestImpl: () => Promise<unknown>;
let botsInfoImpl: (params: { bot: string }) => Promise<unknown>;

// Delegate to the real getConnector / SlackConnector so the real resolution
// path runs, then stub only the web-client seam so no network is touched.
vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: (channelType: string, config: Record<string, unknown>) => {
      capturedBotToken = config.bot_token as string | undefined;
      const connector = actual.getConnector(channelType as never, config) as unknown as {
        web: unknown;
      };
      connector.web = {
        auth: { test: () => authTestImpl() },
        bots: { info: (params: { bot: string }) => botsInfoImpl(params) },
      };
      return connector;
    },
  };
});

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

const { createGatewayChannelsAppInfoService } = await import('./gateway-channels-app-info.js');
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
  },
  agentic_config: null,
  created_by: 'user-1',
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

beforeEach(() => {
  capturedBotToken = undefined;
  findById.mockReset();
  findById.mockResolvedValue(storedChannel);
  authTestImpl = async () => ({
    ok: true,
    team_id: 'T1',
    user_id: 'U1',
    bot_id: 'B1',
  });
  botsInfoImpl = async (params) => ({ ok: true, bot: { id: params.bot, app_id: 'A123' } });
});

describe('gateway-channels/app-info admin gate', () => {
  const gate = requireMinimumRole(ROLES.ADMIN, 'read gateway app info');

  it('rejects an unauthenticated external caller', () => {
    const context = { params: { provider: 'rest' } } as unknown as HookContext;
    expect(() => gate(context)).toThrow(/authentication required/i);
  });

  it('rejects a non-admin caller', () => {
    const context = {
      params: { provider: 'rest', user: { user_id: 'u', role: ROLES.MEMBER } },
    } as unknown as HookContext;
    expect(() => gate(context)).toThrow(/admin/i);
  });

  it('allows an admin caller', () => {
    const context = {
      params: { provider: 'rest', user: { user_id: 'u', role: ROLES.ADMIN } },
    } as unknown as HookContext;
    expect(() => gate(context)).not.toThrow();
  });
});

describe('gateway-channels/app-info hook wiring (register-services)', () => {
  // A sub-path service does not inherit the parent gateway-channels hooks, so
  // the registration MUST attach its own auth + admin gate on create. Mirrors
  // the source-level wiring check used for `gateway-channels/test`.
  const source = readFileSync(join(__dirname, '..', 'register-services.ts'), 'utf8');
  const start = source.indexOf("app.service('gateway-channels/app-info').hooks(");
  const block = start === -1 ? '' : source.slice(start, start + 300);

  it('gates create with requireAuth then admin role', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/create:\s*\[\s*ctx\.requireAuth,\s*requireMinimumRole\(ROLES\.ADMIN/);
  });

  it('suppresses realtime publication of the create result', () => {
    // Without a per-service publisher the default `created` event falls
    // through the global publisher's `global` scope and the app-info result
    // would broadcast to every authenticated socket.
    expect(source).toMatch(/app\.service\('gateway-channels\/app-info'\)\.publish\(\(\) => \[\]\)/);
  });
});

describe('gateway-channels/app-info service', () => {
  it('resolves the app id through the real connector using the decrypted stored token', async () => {
    const service = createGatewayChannelsAppInfoService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });

    expect(findById).toHaveBeenCalledWith('chan-1');
    expect(capturedBotToken).toBe(STORED_BOT_TOKEN);
    expect(result).toEqual({ appId: 'A123', teamId: 'T1' });
  });

  it('requires a gatewayChannelId and 404s on an unknown channel', async () => {
    const service = createGatewayChannelsAppInfoService({} as never);

    await expect(service.create({})).rejects.toThrow(/gatewayChannelId/);

    findById.mockResolvedValue(null);
    await expect(service.create({ gatewayChannelId: 'missing' })).rejects.toThrow(/not found/i);
  });

  it('returns nulls instead of erroring when the connector cannot be built', async () => {
    // No bot_token stored → SlackConnector constructor throws → unresolved.
    findById.mockResolvedValue({ ...storedChannel, config: {} });
    const service = createGatewayChannelsAppInfoService({} as never);

    await expect(service.create({ gatewayChannelId: 'chan-1' })).resolves.toEqual({
      appId: null,
      teamId: null,
    });
  });

  it('returns a result free of token values or prefixes, even on Slack errors', async () => {
    botsInfoImpl = async () => {
      throw { data: { ok: false, error: 'bot_not_found' } };
    };
    const service = createGatewayChannelsAppInfoService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });
    const serialized = JSON.stringify(result);

    expect(result).toEqual({ appId: null, teamId: 'T1' });
    expect(serialized).not.toContain(STORED_BOT_TOKEN);
    expect(serialized).not.toContain('xoxb');
  });
});
