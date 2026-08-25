import type { GatewayChannelRepository, TenantScopeAwareDatabase } from '@agor/core/db';
import type { GatewayConnector } from '@agor/core/gateway';
import { getConnector } from '@agor/core/gateway';
import {
  DEFAULT_DISCORD_CATCH_UP,
  type GatewayChannel,
  type GatewayChannelID,
  type GatewayConnectionTestResult,
  mergeGatewayChannelConfigPatch,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '../adapters/drizzle';
import { GatewayChannelsService } from './gateway-channels';

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return { ...actual, getConnector: vi.fn() };
});

const applicationId = '111111111111111111';

const currentConfig: Record<string, unknown> = {
  bot_token: 'discord-secret',
  application_id: applicationId,
  guild_id: '222222222222222222',
  allowed_channel_ids: ['333333333333333333'],
  allowed_user_ids: ['444444444444444444'],
  allowed_role_ids: [],
  message_content_enabled: true,
  thread_mode: 'public_thread_per_summon',
  thread_auto_archive_minutes: 1440,
  align_discord_users: false,
  ...withDiscordDefaults(),
};

function withDiscordDefaults(): Record<string, unknown> {
  return {
    catch_up: { ...DEFAULT_DISCORD_CATCH_UP },
    files: false,
    agent_tools: [],
  };
}

const channel: GatewayChannel = {
  id: 'channel-1' as GatewayChannelID,
  created_by: 'user-1',
  name: 'Discord',
  channel_type: 'discord',
  target_branch_id: 'branch-1' as GatewayChannel['target_branch_id'],
  agor_user_id: 'user-1',
  provider_installation_id: applicationId,
  provider_config_generation: 4,
  channel_key: 'channel-key',
  config: currentConfig,
  agentic_config: null,
  enabled: true,
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
  last_message_at: null,
};

function verifiedResult(): GatewayConnectionTestResult {
  return {
    ok: true,
    bot: { userId: applicationId, name: 'Agor' },
    verifiedInstallationId: applicationId,
    verification: { status: 'verified', warnings: [] },
    failures: [],
    notVerifiable: [],
  };
}

function makeService() {
  const updateWithVerifiedDiscordInstallation = vi.fn(
    async (
      _id: string,
      _updates: Partial<GatewayChannel>,
      _providerInstallationId: string,
      expectedProviderConfigGeneration: number
    ) => ({
      ...channel,
      provider_config_generation: expectedProviderConfigGeneration + 1,
    })
  );
  const findById = vi.fn(async () => channel);
  const channelRepo = {
    findById,
    updateWithVerifiedDiscordInstallation,
  } as unknown as GatewayChannelRepository;
  const repository = {
    findById: vi.fn(async () => channel),
    update: vi.fn(async () => channel),
  } as unknown as Repository<GatewayChannel>;
  const service = new GatewayChannelsService({} as TenantScopeAwareDatabase);
  (service as unknown as { channelRepo: GatewayChannelRepository }).channelRepo = channelRepo;
  (service as unknown as { repository: Repository<GatewayChannel> }).repository = repository;
  return { service, channelRepo, findById, repository, updateWithVerifiedDiscordInstallation };
}

describe('GatewayChannelsService Discord provider verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probes the exact merged authority config and commits through the generation CAS', async () => {
    const { service, updateWithVerifiedDiscordInstallation } = makeService();
    const testConnection = vi.fn(async () => verifiedResult());
    vi.mocked(getConnector).mockReturnValue({ testConnection } as unknown as GatewayConnector);

    await service.patch(channel.id, {
      config: { allowed_channel_ids: ['555555555555555555'] },
    });

    const probedConfig = vi.mocked(getConnector).mock.calls[0]?.[1];
    expect(probedConfig).toEqual(
      mergeGatewayChannelConfigPatch(
        currentConfig,
        { allowed_channel_ids: ['555555555555555555'] },
        'discord',
        true
      )
    );
    expect(testConnection).toHaveBeenCalledOnce();
    expect(updateWithVerifiedDiscordInstallation).toHaveBeenCalledWith(
      channel.id,
      {
        config: { allowed_channel_ids: ['555555555555555555'] },
      },
      applicationId,
      channel.provider_config_generation
    );
  });

  it('does not persist a failed probe and does not retry a stale CAS', async () => {
    const failed = makeService();
    const failedProbe = vi.fn(
      async (): Promise<GatewayConnectionTestResult> => ({
        ...verifiedResult(),
        ok: false,
        failures: [{ capability: 'bot_token', reason: 'invalid token' }],
      })
    );
    vi.mocked(getConnector).mockReturnValue({
      testConnection: failedProbe,
    } as unknown as GatewayConnector);

    await expect(
      failed.service.patch(channel.id, { config: { guild_id: '666666666666666666' } })
    ).rejects.toThrow('Discord verification failed');
    expect(failed.updateWithVerifiedDiscordInstallation).not.toHaveBeenCalled();

    const stale = makeService();
    const staleUpdate = stale.updateWithVerifiedDiscordInstallation;
    staleUpdate.mockRejectedValueOnce(
      new Error('Discord verification became stale while the gateway configuration changed')
    );
    vi.mocked(getConnector).mockReturnValue({
      testConnection: vi.fn(async () => verifiedResult()),
    } as unknown as GatewayConnector);

    await expect(
      stale.service.patch(channel.id, { config: { guild_id: '666666666666666666' } })
    ).rejects.toThrow('Discord verification became stale');
    expect(staleUpdate).toHaveBeenCalledOnce();
  });

  it('rejects provider-authority multi-patches before loading or probing', async () => {
    const { service, findById } = makeService();

    await expect(
      service.patch(null, { config: { guild_id: '666666666666666666' } })
    ).rejects.toThrow('cannot be multi-patched');
    expect(findById).not.toHaveBeenCalled();
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('skips a redundant probe for the verified widget seam and for disabled authority writes', async () => {
    const verified = makeService();
    await verified.service.patchWithVerifiedDiscordInstallation(
      channel.id,
      { config: { guild_id: '666666666666666666' }, enabled: true },
      applicationId,
      channel.provider_config_generation
    );
    expect(getConnector).not.toHaveBeenCalled();
    expect(verified.updateWithVerifiedDiscordInstallation).toHaveBeenCalledOnce();

    const disabled = makeService();
    await disabled.service.patch(channel.id, { enabled: false });
    expect(getConnector).not.toHaveBeenCalled();
    expect(disabled.updateWithVerifiedDiscordInstallation).not.toHaveBeenCalled();
    expect(disabled.repository.update).toHaveBeenCalledWith(channel.id, { enabled: false });
  });
});
