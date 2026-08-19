import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayChannel } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const APPLICATION_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';
const CHANNEL_ID = '019fd900-0000-7000-8000-000000000001';
const USER_ID = '019fd900-0000-7000-8000-000000000002';
let applyImpl: (options: {
  signal?: AbortSignal;
  beforePatch: (applicationId: string) => Promise<void>;
}) => Promise<Record<string, unknown>>;
const stopListening = vi.fn(async () => undefined);
let connectorCount = 0;
let patchCount = 0;

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    DiscordConnector: class {
      constructor() {
        connectorCount += 1;
      }
      applyRecommendedApplicationSettings = (options: {
        signal?: AbortSignal;
        beforePatch: (applicationId: string) => Promise<void>;
      }) => applyImpl(options);
      stopListening = stopListening;
    },
  };
});

const findById = vi.fn();
const claimProviderProbe = vi.fn();
const renewProviderProbe = vi.fn();
const claimProviderInstallationIdentity = vi.fn();
const providerProbeClaimIsCurrent = vi.fn();
const releaseProviderProbe = vi.fn();

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    GatewayChannelRepository: class {
      findById = findById;
      claimProviderProbe = claimProviderProbe;
      renewProviderProbe = renewProviderProbe;
      claimProviderInstallationIdentity = claimProviderInstallationIdentity;
      providerProbeClaimIsCurrent = providerProbeClaimIsCurrent;
      releaseProviderProbe = releaseProviderProbe;
    },
  };
});

const { createGatewayDiscordApplicationSettingsService } = await import(
  './gateway-channels-discord-application-settings.js'
);
const { ProviderInstallationConflictError, RepositoryError } = await import('@agor/core/db');

const config = {
  bot_token: 'discord-secret',
  application_id: APPLICATION_ID,
  guild_id: GUILD_ID,
  allowed_channel_ids: ['423456789012345678'],
  align_discord_users: false,
};

const initialChannel = {
  id: CHANNEL_ID,
  name: 'Discord staging',
  channel_type: 'discord',
  channel_key: 'key',
  enabled: false,
  target_branch_id: '019fd900-0000-7000-8000-000000000003',
  agor_user_id: USER_ID,
  provider_installation_id: null,
  provider_config_generation: 3,
  config,
  agentic_config: null,
  created_by: USER_ID,
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

const currentChannel = {
  ...initialChannel,
  provider_installation_id: APPLICATION_ID,
  provider_config_generation: 4,
};

beforeEach(() => {
  vi.useRealTimers();
  connectorCount = 0;
  patchCount = 0;
  stopListening.mockClear();
  findById.mockReset();
  findById.mockResolvedValueOnce(initialChannel).mockResolvedValue(currentChannel);
  claimProviderProbe.mockReset();
  claimProviderProbe.mockResolvedValue({
    outcome: 'claimed',
    lease: {
      channel_id: CHANNEL_ID,
      claim_token: 'probe-token',
      generation: 7,
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
  claimProviderInstallationIdentity.mockReset();
  claimProviderInstallationIdentity.mockResolvedValue(true);
  providerProbeClaimIsCurrent.mockReset();
  providerProbeClaimIsCurrent.mockResolvedValue(true);
  releaseProviderProbe.mockReset();
  releaseProviderProbe.mockResolvedValue(true);
  applyImpl = async (options) => {
    await options.beforePatch(APPLICATION_ID);
    if (options.signal?.aborted) throw options.signal.reason;
    patchCount += 1;
    return {
      applicationId: APPLICATION_ID,
      installUrl: 'https://discord.com/oauth2/authorize?safe=1',
      messageContentAccess: true,
      guildInstallDefaults: true,
      intentNames: ['Guilds', 'Guild Messages', 'Message Content (privileged)'],
      permissionNames: ['View Channel'],
      permissions: '309237746688',
    };
  };
});

describe('Discord application-settings service wiring', () => {
  const source = readFileSync(join(__dirname, '..', 'register-services.ts'), 'utf8');
  const start = source.indexOf(
    "app.service('gateway-channels/discord-application-settings').hooks("
  );
  const block = start === -1 ? '' : source.slice(start, start + 420);

  it('is create-only, admin-gated, and never published', () => {
    expect(source).toMatch(
      /gateway-channels\/discord-application-settings'[\s\S]{0,180}methods: \['create'\]/
    );
    expect(block).toMatch(/create:\s*\[[\s\S]*ctx\.requireAuth,[\s\S]*ROLES\.ADMIN/);
    expect(source).toMatch(
      /app\.service\('gateway-channels\/discord-application-settings'\)\.publish\(\(\) => \[\]\)/
    );
  });
});

describe('Discord application-settings service', () => {
  it('binds the exact installation before PATCH and retains the renewable probe fence', async () => {
    const result = await createGatewayDiscordApplicationSettingsService({} as never).create({
      gatewayChannelId: CHANNEL_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      ambiguous: false,
      requiresRetest: true,
      applicationId: APPLICATION_ID,
      code: 'applied',
    });
    expect(patchCount).toBe(1);
    expect(claimProviderInstallationIdentity).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      channelType: 'discord',
      providerInstallationId: APPLICATION_ID,
      expectedConfig: { application_id: APPLICATION_ID, bot_token: 'discord-secret' },
      expectedConfigGeneration: 3,
      providerProbe: { claimToken: 'probe-token', generation: 7 },
      retainProviderProbeLeaseMs: 30_000,
    });
    expect(providerProbeClaimIsCurrent).toHaveBeenCalledWith(CHANNEL_ID, 'probe-token', 7, 4);
    expect(stopListening).toHaveBeenCalledOnce();
    expect(releaseProviderProbe).toHaveBeenCalledWith(CHANNEL_ID, 'probe-token', 7);
  });

  it('rejects duplicate installation ownership generically before PATCH', async () => {
    claimProviderInstallationIdentity.mockRejectedValue(new ProviderInstallationConflictError());
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toMatchObject({
      name: 'Conflict',
      message: 'Provider installation is already connected',
    });
    expect(patchCount).toBe(0);
  });

  it('aborts before PATCH when the heartbeat loses ownership', async () => {
    vi.useFakeTimers();
    renewProviderProbe.mockResolvedValueOnce(null);
    applyImpl = (options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    const pending = createGatewayDiscordApplicationSettingsService({} as never).create({
      gatewayChannelId: CHANNEL_ID,
    });
    const rejected = expect(pending).rejects.toThrow(/ownership changed/i);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(patchCount).toBe(0);
    vi.useRealTimers();
  });

  it('returns a sanitized ambiguous result when config rotates after PATCH admission', async () => {
    providerProbeClaimIsCurrent.mockResolvedValue(false);
    const result = await createGatewayDiscordApplicationSettingsService({} as never).create({
      gatewayChannelId: CHANNEL_ID,
    });
    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      requiresRetest: true,
      code: 'configuration_changed_after_apply',
    });
    expect(patchCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('discord-secret');
  });

  it('treats an unexpected post-PATCH response as ambiguous rather than rolling back', async () => {
    applyImpl = async (options) => {
      await options.beforePatch(APPLICATION_ID);
      patchCount += 1;
      throw new Error('provider response included private owner data');
    };
    const result = await createGatewayDiscordApplicationSettingsService({} as never).create({
      gatewayChannelId: CHANNEL_ID,
    });
    expect(result).toMatchObject({ ok: false, ambiguous: true, requiresRetest: true });
    expect(JSON.stringify(result)).not.toContain('private owner');
  });

  it('rejects enabled, non-Discord, malformed, concurrent, and SQLite-only paths', async () => {
    findById.mockReset();
    findById.mockResolvedValue({ ...initialChannel, enabled: true });
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/disable/i);
    expect(connectorCount).toBe(0);

    findById.mockResolvedValue({ ...initialChannel, channel_type: 'slack' });
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/not configured for Discord/);

    findById.mockResolvedValue({ ...initialChannel, config: { ...config, bot_token: undefined } });
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toMatchObject({ name: 'BadRequest' });
    expect(connectorCount).toBe(0);

    findById.mockResolvedValue(initialChannel);
    claimProviderProbe.mockResolvedValueOnce({
      outcome: 'held',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
    });
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toMatchObject({ name: 'Conflict' });

    claimProviderProbe.mockRejectedValueOnce(
      new RepositoryError('Discord setup probes require PostgreSQL')
    );
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/PostgreSQL Cloud/);

    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
        extra: 'not accepted',
      } as never)
    ).rejects.toThrow(/only gatewayChannelId/i);
  });

  it('returns NotFound without a connector when tenant-scoped lookup cannot see the channel', async () => {
    findById.mockReset();
    findById.mockResolvedValue(null);
    await expect(
      createGatewayDiscordApplicationSettingsService({} as never).create({
        gatewayChannelId: CHANNEL_ID,
      })
    ).rejects.toMatchObject({ name: 'NotFound' });
    expect(claimProviderProbe).not.toHaveBeenCalled();
    expect(connectorCount).toBe(0);
  });
});
