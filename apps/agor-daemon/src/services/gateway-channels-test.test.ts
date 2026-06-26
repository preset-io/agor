import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayChannel, HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORED_BOT_TOKEN = 'xoxb-decrypted-secret';
const STORED_APP_TOKEN = 'xapp-decrypted-secret';

// Resolved tokens the service fed into the REAL connector. Lets the
// substitution tests prove the decrypted stored tokens reach the probe
// end-to-end while still exercising the real SlackConnector.testConnection().
let capturedBotToken: string | undefined;
let capturedAppToken: string | undefined;
const conversationsInfoChannels: string[] = [];

let authTestImpl: () => Promise<unknown>;
let appOpenImpl: () => Promise<unknown>;
let conversationsInfoImpl: (args: { channel: string }) => Promise<unknown>;

// Delegate to the real getConnector / SlackConnector so the real probe strings
// run, then stub only the web-client seam so no network is touched.
vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: (channelType: string, config: Record<string, unknown>) => {
      capturedBotToken = config.bot_token as string | undefined;
      const connector = actual.getConnector(channelType as never, config) as unknown as {
        web: unknown;
        createWebClient: (token: string) => unknown;
      };
      connector.web = {
        auth: { test: () => authTestImpl() },
        conversations: {
          info: (args: { channel: string }) => {
            conversationsInfoChannels.push(args.channel);
            return conversationsInfoImpl(args);
          },
        },
      };
      connector.createWebClient = (token: string) => {
        capturedAppToken = token;
        return { apps: { connections: { open: () => appOpenImpl() } } };
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
  capturedBotToken = undefined;
  capturedAppToken = undefined;
  conversationsInfoChannels.length = 0;
  findById.mockReset();
  findById.mockResolvedValue(storedChannel);
  authTestImpl = async () => ({
    ok: true,
    team_id: 'T1',
    team: 'Acme',
    user_id: 'U1',
    user: 'agor-bot',
  });
  appOpenImpl = async () => ({ ok: true, url: 'wss://example' });
  conversationsInfoImpl = async (args) => ({ ok: true, channel: { id: args.channel } });
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

describe('gateway-channels/test hook wiring (register-services)', () => {
  // A sub-path service does not inherit the parent gateway-channels hooks, so
  // the registration MUST attach its own auth + admin gate on create. Mirrors
  // the source-level wiring check used for `/mcp-servers/discover`.
  const source = readFileSync(join(__dirname, '..', 'register-services.ts'), 'utf8');
  const start = source.indexOf("app.service('gateway-channels/test').hooks(");
  const block = start === -1 ? '' : source.slice(start, start + 300);

  it('gates create with requireAuth then admin role', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/create:\s*\[\s*ctx\.requireAuth,\s*requireMinimumRole\(ROLES\.ADMIN/);
  });
});

describe('gateway-channels/test service', () => {
  it('substitutes decrypted stored tokens into the real connector', async () => {
    const service = createGatewayChannelsTestService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });

    expect(findById).toHaveBeenCalledWith('chan-1');
    // Both decrypted tokens reached the real probe.
    expect(capturedBotToken).toBe(STORED_BOT_TOKEN);
    expect(capturedAppToken).toBe(STORED_APP_TOKEN);
    expect(result.ok).toBe(true);
  });

  it('keeps stored secrets when overrides send the redaction sentinel', async () => {
    const service = createGatewayChannelsTestService({} as never);

    await service.create({
      gatewayChannelId: 'chan-1',
      config: { bot_token: '••••••••', allowed_channel_ids: ['C2'] },
    });

    // Sentinel secret → stored token preserved; real override → applied.
    expect(capturedBotToken).toBe(STORED_BOT_TOKEN);
    expect(conversationsInfoChannels).toEqual(['C2']);
  });

  it('returns a result free of token values or prefixes, even on errors', async () => {
    // Representative error mix that still exercises the real probe strings.
    appOpenImpl = async () => {
      throw {
        data: {
          ok: false,
          error: 'missing_scope',
          needed: 'connections:write',
          provided: 'chat:write',
        },
      };
    };
    conversationsInfoImpl = async () => {
      throw { data: { ok: false, error: 'not_in_channel' } };
    };
    const service = createGatewayChannelsTestService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(serialized).not.toContain(STORED_BOT_TOKEN);
    expect(serialized).not.toContain(STORED_APP_TOKEN);
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain('xapp');
  });
});
