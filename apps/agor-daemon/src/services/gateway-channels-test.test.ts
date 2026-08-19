import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayChannel, HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
let discordProbeResult: Record<string, unknown>;
let discordProbeImpl: (options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
let discordConnectorConstructionCount = 0;
const discordStopListening = vi.fn(async () => undefined);

// Delegate to the real getConnector / SlackConnector so the real probe strings
// run, then stub only the web-client seam so no network is touched.
vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    DiscordConnector: class {
      constructor() {
        discordConnectorConstructionCount += 1;
      }
      testConnection = (options?: { signal?: AbortSignal }) => discordProbeImpl(options);
      stopListening = discordStopListening;
    },
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
const claimProviderInstallationIdentity = vi.fn();
const claimProviderProbe = vi.fn();
const renewProviderProbe = vi.fn();
const providerProbeClaimIsCurrent = vi.fn();
const releaseProviderProbe = vi.fn();

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    GatewayChannelRepository: class {
      findById = findById;
      claimProviderInstallationIdentity = claimProviderInstallationIdentity;
      claimProviderProbe = claimProviderProbe;
      renewProviderProbe = renewProviderProbe;
      providerProbeClaimIsCurrent = providerProbeClaimIsCurrent;
      releaseProviderProbe = releaseProviderProbe;
    },
  };
});

const { createGatewayChannelsTestService } = await import('./gateway-channels-test.js');
const { requireMinimumRole } = await import('../utils/authorization.js');
const { ProviderInstallationConflictError, RepositoryError } = await import('@agor/core/db');

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
  discordConnectorConstructionCount = 0;
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
  claimProviderInstallationIdentity.mockReset();
  claimProviderInstallationIdentity.mockResolvedValue(true);
  claimProviderProbe.mockReset();
  claimProviderProbe.mockResolvedValue({
    outcome: 'claimed',
    lease: {
      channel_id: 'chan-1',
      claim_token: 'probe-token',
      generation: 4,
      provider_config_generation: 3,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
    },
  });
  renewProviderProbe.mockReset();
  renewProviderProbe.mockImplementation(async (input) => ({
    channel_id: input.channelId,
    claim_token: input.claimToken,
    generation: input.generation,
    provider_config_generation: input.providerConfigGeneration,
    lease_expires_at: '2099-01-01T00:00:00.000Z',
  }));
  providerProbeClaimIsCurrent.mockReset();
  providerProbeClaimIsCurrent.mockResolvedValue(true);
  releaseProviderProbe.mockReset();
  releaseProviderProbe.mockResolvedValue(true);
  discordStopListening.mockClear();
  discordProbeResult = {
    ok: true,
    providerInstallationId: '223456789012345678',
    failures: [],
    notVerifiable: [],
  };
  discordProbeImpl = async () => discordProbeResult;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gateway-channels/test admin gate', () => {
  const gate = requireMinimumRole(ROLES.ADMIN, 'test gateway channels');

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

  it('suppresses realtime publication of the create result', () => {
    // Without a per-service publisher the default `created` event falls
    // through the global publisher's `global` scope and the full probe result
    // would broadcast to every authenticated socket.
    expect(source).toMatch(/app\.service\('gateway-channels\/test'\)\.publish\(\(\) => \[\]\)/);
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

  it('materializes a successful Discord token/application binding on the stored channel', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    const service = createGatewayChannelsTestService({} as never);

    const result = await service.create({ gatewayChannelId: 'chan-1' });

    expect(result.ok).toBe(true);
    expect(claimProviderInstallationIdentity).toHaveBeenCalledWith({
      channelId: 'chan-1',
      channelType: 'discord',
      providerInstallationId: '223456789012345678',
      expectedConfig: {
        application_id: '223456789012345678',
        bot_token: 'discord-secret',
      },
      expectedConfigGeneration: 3,
      providerProbe: { claimToken: 'probe-token', generation: 4 },
    });
    expect(discordStopListening).toHaveBeenCalledOnce();
    expect(releaseProviderProbe).toHaveBeenCalledWith('chan-1', 'probe-token', 4);
  });

  it('renews a slow probe and keeps a second daemon from constructing a client', async () => {
    vi.useFakeTimers();
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    let claimCount = 0;
    claimProviderProbe.mockImplementation(async () => {
      claimCount += 1;
      return claimCount === 1
        ? {
            outcome: 'claimed',
            lease: {
              channel_id: 'chan-1',
              claim_token: 'probe-token',
              generation: 4,
              provider_config_generation: 3,
              lease_expires_at: '2099-01-01T00:00:00.000Z',
            },
          }
        : { outcome: 'held', lease_expires_at: '2099-01-01T00:00:00.000Z' };
    });
    discordProbeImpl = (options) =>
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
        setTimeout(() => resolve(discordProbeResult), 40_000);
      });

    const first = createGatewayChannelsTestService({} as never).create({
      gatewayChannelId: 'chan-1',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(renewProviderProbe).toHaveBeenCalledTimes(2);

    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'probe_in_progress' }],
    });
    expect(discordConnectorConstructionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(28_000);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(renewProviderProbe.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(claimProviderInstallationIdentity).toHaveBeenCalledOnce();
  });

  it('aborts remaining provider work and refuses binding when heartbeat renewal loses its fence', async () => {
    vi.useFakeTimers();
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    renewProviderProbe.mockResolvedValueOnce(null);
    discordProbeImpl = (options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });

    const pending = createGatewayChannelsTestService({} as never).create({
      gatewayChannelId: 'chan-1',
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'probe_ownership_lost' }],
    });
    expect(providerProbeClaimIsCurrent).not.toHaveBeenCalled();
    expect(claimProviderInstallationIdentity).not.toHaveBeenCalled();
    expect(discordStopListening).toHaveBeenCalledOnce();
  });

  it('aborts a renewing probe at its bounded total deadline', async () => {
    vi.useFakeTimers();
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    discordProbeImpl = (options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });

    const pending = createGatewayChannelsTestService({} as never).create({
      gatewayChannelId: 'chan-1',
    });
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'probe_deadline_exceeded' }],
    });
    expect(renewProviderProbe.mock.calls.length).toBeGreaterThan(1);
    expect(claimProviderInstallationIdentity).not.toHaveBeenCalled();
  });

  it('fails Discord setup when the config changes between probe and claim', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    claimProviderInstallationIdentity.mockResolvedValue(false);

    const result = await createGatewayChannelsTestService({} as never).create({
      gatewayChannelId: 'chan-1',
    });

    expect(result).toMatchObject({
      ok: false,
      failures: [{ capability: 'config_changed' }],
    });
  });

  it('returns only a generic conflict for an already-connected Discord installation', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    claimProviderInstallationIdentity.mockRejectedValue(new ProviderInstallationConflictError());

    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).rejects.toMatchObject({
      name: 'Conflict',
      message: 'Provider installation is already connected',
    });
  });

  it('requires a saved disabled Discord channel before probing', async () => {
    const service = createGatewayChannelsTestService({} as never);
    await expect(
      service.create({
        channelType: 'discord',
        config: {
          bot_token: 'unsaved',
          application_id: '223456789012345678',
          guild_id: '323456789012345678',
          allowed_channel_ids: ['423456789012345678'],
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'persisted_channel_required' }],
    });
    expect(claimProviderProbe).not.toHaveBeenCalled();
    expect(discordConnectorConstructionCount).toBe(0);

    findById.mockResolvedValue({ ...storedChannel, channel_type: 'discord', enabled: true });
    await expect(service.create({ gatewayChannelId: 'chan-1' })).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'channel_must_be_disabled' }],
    });
    expect(claimProviderProbe).not.toHaveBeenCalled();
  });

  it('rejects unsaved Discord overrides before claiming or constructing a connector', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });

    await expect(
      createGatewayChannelsTestService({} as never).create({
        gatewayChannelId: 'chan-1',
        config: { guild_id: '523456789012345678' },
      })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'config_must_be_saved' }],
    });
    expect(claimProviderProbe).not.toHaveBeenCalled();
    expect(discordStopListening).not.toHaveBeenCalled();
    expect(discordConnectorConstructionCount).toBe(0);
  });

  it('fails closed when a green Discord probe has no verified application identity', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    discordProbeResult = { ok: true, failures: [], notVerifiable: [] };

    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'installation_identity_unverified' }],
    });
    expect(claimProviderInstallationIdentity).not.toHaveBeenCalled();
    expect(discordStopListening).toHaveBeenCalledOnce();
  });

  it('serializes disabled-channel probes and rejects SQLite/local ownership', async () => {
    findById.mockResolvedValue({ ...storedChannel, channel_type: 'discord', enabled: false });
    claimProviderProbe.mockResolvedValueOnce({
      outcome: 'held',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
    });
    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'probe_in_progress' }],
    });
    expect(discordConnectorConstructionCount).toBe(0);

    claimProviderProbe.mockRejectedValueOnce(
      new RepositoryError('Discord setup probes require PostgreSQL')
    );
    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'postgresql_required' }],
    });

    claimProviderProbe.mockRejectedValueOnce(new Error('database connection string'));
    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'probe_unavailable' }],
    });
  });

  it('fences a config change during probe and always disposes the connector', async () => {
    findById.mockResolvedValue({
      ...storedChannel,
      channel_type: 'discord',
      enabled: false,
      provider_config_generation: 3,
      config: {
        bot_token: 'discord-secret',
        application_id: '223456789012345678',
        guild_id: '323456789012345678',
        allowed_channel_ids: ['423456789012345678'],
        align_discord_users: false,
      },
    });
    providerProbeClaimIsCurrent.mockResolvedValue(false);

    await expect(
      createGatewayChannelsTestService({} as never).create({ gatewayChannelId: 'chan-1' })
    ).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'config_changed' }],
    });
    expect(claimProviderInstallationIdentity).not.toHaveBeenCalled();
    expect(discordStopListening).toHaveBeenCalledOnce();
    expect(releaseProviderProbe).toHaveBeenCalledWith('chan-1', 'probe-token', 4);
  });
});
