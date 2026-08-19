import {
  AgenticToolPresetRepository,
  BranchRepository,
  eq,
  GatewayChannelRepository,
  gatewayChannels,
  generateId,
  isEncrypted,
  RepoRepository,
  select,
  type TenantScopeAwareDatabase,
  UsersRepository,
  update,
} from '@agor/core/db';
import type { BranchID, GatewayChannel, UUID } from '@agor/core/types';
import { USER_DEFAULT_AGENTIC_CONFIGURATION } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { GatewayChannelsService } from './gateway-channels';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-agentic-config-test-secret';
});

describe('GatewayChannelsService exact agentic configuration', () => {
  it('rejects My default when execution-owner alignment is unstable', async () => {
    await expect(
      new GatewayChannelsService({} as TenantScopeAwareDatabase).create({
        agor_user_id: 'fallback-user',
        config: { align_slack_users: true },
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      })
    ).rejects.toThrow(/stable execution owner/i);
  });

  it('treats default-on Discord user alignment as an unstable execution owner', async () => {
    await expect(
      new GatewayChannelsService({} as TenantScopeAwareDatabase).create({
        name: 'Discord channel',
        channel_type: 'discord',
        target_branch_id: generateId() as BranchID,
        agor_user_id: generateId(),
        enabled: false,
        config: {
          application_id: '123456789012345678',
          guild_id: '223456789012345678',
          allowed_channel_ids: ['323456789012345678'],
          user_map: { '423456789012345678': generateId() },
        },
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      })
    ).rejects.toThrow(/stable execution owner/i);
  });

  it('does not treat alignment-off Discord config without Run as user as stable', async () => {
    await expect(
      new GatewayChannelsService({} as TenantScopeAwareDatabase).create({
        name: 'Discord fixed identity',
        channel_type: 'discord',
        target_branch_id: generateId() as BranchID,
        enabled: false,
        config: {
          application_id: '123456789012345678',
          guild_id: '223456789012345678',
          allowed_channel_ids: ['323456789012345678'],
          align_discord_users: false,
        },
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      })
    ).rejects.toThrow(/Run as user/i);
  });

  it('rejects malformed enabled Discord config as a request error before persistence', async () => {
    await expect(
      new GatewayChannelsService({} as TenantScopeAwareDatabase).create({
        name: 'Discord channel',
        channel_type: 'discord',
        target_branch_id: generateId() as BranchID,
        enabled: true,
        config: { bot_token: 'secret' },
      })
    ).rejects.toMatchObject({ name: 'BadRequest' });
  });

  it('admits an enabled verified Discord config only on PostgreSQL', () => {
    const applicationId = '123456789012345678';
    const channel = {
      agor_user_id: generateId(),
      channel_type: 'discord' as const,
      enabled: true,
      provider_installation_id: applicationId,
      config: {
        bot_token: 'discord-secret',
        application_id: applicationId,
        guild_id: '223456789012345678',
        allowed_channel_ids: ['323456789012345678'],
        align_discord_users: false,
      },
    };
    type Validator = {
      validateChannelConfig(input: typeof channel): Record<string, unknown>;
    };

    const postgresService = new GatewayChannelsService({} as TenantScopeAwareDatabase);
    expect((postgresService as unknown as Validator).validateChannelConfig(channel)).toMatchObject({
      application_id: applicationId,
      bot_token: 'discord-secret',
    });

    const sqliteService = new GatewayChannelsService({ run: () => undefined } as never);
    expect(() => (sqliteService as unknown as Validator).validateChannelConfig(channel)).toThrow(
      /PostgreSQL/i
    );
  });

  dbTest('keeps a valid secretless Discord draft disabled on SQLite', async ({ db }) => {
    const { data, owner } = await channelData(db);
    const service = new GatewayChannelsService(db);
    const draft = await service.create(
      {
        ...data,
        name: 'Discord draft',
        channel_type: 'discord',
        config: {
          application_id: '123456789012345678',
          guild_id: '223456789012345678',
          allowed_channel_ids: ['323456789012345678'],
          align_discord_users: false,
        },
        agentic_config: null,
        enabled: false,
      },
      { user: owner } as never
    );

    await expect(
      service.patch(draft.id, { enabled: true }, { user: owner } as never)
    ).rejects.toThrow(/bot_token/i);
    expect((await service.get(draft.id, { user: owner } as never)).enabled).toBe(false);
  });

  dbTest('accepts only tenant-visible users in a Discord alignment map', async ({ db }) => {
    const { data, owner } = await channelData(db);
    const service = new GatewayChannelsService(db);
    const draft = await service.create(
      {
        ...data,
        name: 'Aligned Discord draft',
        channel_type: 'discord',
        config: {
          application_id: '123456789012345678',
          guild_id: '223456789012345678',
          allowed_channel_ids: ['323456789012345678'],
          align_discord_users: true,
          user_map: { '423456789012345678': owner.user_id },
        },
        agentic_config: null,
        enabled: false,
      },
      { user: owner } as never
    );

    const unavailableUserId = generateId();
    await expect(
      service.patch(
        draft.id,
        { config: { user_map: { '423456789012345678': unavailableUserId } } },
        { user: owner } as never
      )
    ).rejects.toThrow(/unavailable Agor user/i);
    expect((await service.get(draft.id, { user: owner } as never)).config).toMatchObject({
      user_map: { '423456789012345678': owner.user_id },
    });
  });

  dbTest(
    'keeps a verified Discord channel disabled on SQLite and rejects malformed config',
    async ({ db }) => {
      const { data, owner } = await channelData(db);
      const service = new GatewayChannelsService(db);
      const draft = await service.create(
        {
          ...data,
          name: 'Discord channel',
          channel_type: 'discord',
          config: {
            bot_token: 'discord-secret',
            application_id: '123456789012345678',
            guild_id: '223456789012345678',
            allowed_channel_ids: ['323456789012345678'],
            align_discord_users: false,
          },
          agentic_config: null,
          enabled: false,
        },
        { user: owner } as never
      );
      await expect(
        service.patch(draft.id, { enabled: true }, { user: owner } as never)
      ).rejects.toThrow(/PostgreSQL/i);
      await new GatewayChannelRepository(db).claimProviderInstallationIdentity({
        channelId: draft.id,
        channelType: 'discord',
        providerInstallationId: '123456789012345678',
        expectedConfig: {
          application_id: '123456789012345678',
          bot_token: 'discord-secret',
        },
      });
      await expect(
        service.patch(draft.id, { enabled: true }, { user: owner } as never)
      ).rejects.toThrow(/PostgreSQL/i);
      await expect(
        service.patch(draft.id, { config: { allowed_channel_ids: [] } }, { user: owner } as never)
      ).rejects.toMatchObject({ name: 'BadRequest' });
      expect((await service.get(draft.id, { user: owner } as never)).config).toMatchObject({
        allowed_channel_ids: ['323456789012345678'],
      });
      expect((await service.get(draft.id, { user: owner } as never)).enabled).toBe(false);
    }
  );

  dbTest('returns BadRequest when enable races an active Discord setup probe', async ({ db }) => {
    const { data, owner } = await channelData(db);
    const service = new GatewayChannelsService(db);
    const draft = await service.create(
      {
        ...data,
        name: 'Discord probe race',
        channel_type: 'discord',
        config: {
          bot_token: 'discord-secret',
          application_id: '123456789012345678',
          guild_id: '223456789012345678',
          allowed_channel_ids: ['323456789012345678'],
          align_discord_users: false,
        },
        agentic_config: null,
        enabled: false,
      },
      { user: owner } as never
    );
    await new GatewayChannelRepository(db).claimProviderInstallationIdentity({
      channelId: draft.id,
      channelType: 'discord',
      providerInstallationId: '123456789012345678',
      expectedConfig: {
        application_id: '123456789012345678',
        bot_token: 'discord-secret',
      },
    });
    await update(db, gatewayChannels)
      .set({
        provider_probe_claim_token: 'probe-token',
        provider_probe_lease_expires_at: new Date(Date.now() + 60_000),
        provider_probe_generation: 1,
        provider_probe_config_generation: 2,
      })
      .where(eq(gatewayChannels.id, draft.id))
      .run();

    await expect(
      service.patch(draft.id, { enabled: true }, { user: owner } as never)
    ).rejects.toMatchObject({ name: 'BadRequest' });
    expect((await service.get(draft.id, { user: owner } as never)).enabled).toBe(false);
  });

  dbTest('rejects an incomplete inline OpenCode pair before persistence', async ({ db }) => {
    const { data, owner } = await channelData(db);

    await expect(
      new GatewayChannelsService(db).create(
        {
          ...data,
          agentic_config: {
            agent: 'opencode',
            modelConfig: { mode: 'exact', provider: 'openai' },
          } as unknown as GatewayChannel['agentic_config'],
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/provider and model/i);
    expect(await new GatewayChannelRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('resolves an exact OpenCode pair from the stable execution owner', async ({ db }) => {
    const { data, owner } = await channelData(db, true);

    const created = await new GatewayChannelsService(db).create(data, { user: owner } as never);

    expect(created.agentic_config).toMatchObject({
      agent: 'opencode',
      modelConfig: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-test',
        updated_at: expect.any(String),
      },
    });
  });

  dbTest('round-trips a stable-owner My default create outside the preset FK', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const created = await new GatewayChannelsService(db).create(
      {
        ...data,
        agentic_config: {
          agent: 'opencode',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
          envVars: [{ key: 'TOKEN', value: 'secret-value', forceOverride: false }],
        },
      },
      { user: owner } as never
    );

    expect(created.agentic_config).toMatchObject({
      presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      envVars: [{ key: 'TOKEN', value: 'secret-value', forceOverride: false }],
    });
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    const stored = raw?.agentic_config as Record<string, unknown>;
    expect(raw?.agentic_tool_preset_id).toBeNull();
    expect(stored.presetId).toBe(USER_DEFAULT_AGENTIC_CONFIGURATION);
    expect(isEncrypted((stored.envVars as Array<{ value: string }>)[0]?.value ?? '')).toBe(true);
  });

  dbTest('round-trips a stable-owner My default patch outside the preset FK', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const service = new GatewayChannelsService(db);
    const created = await service.create(data, { user: owner } as never);
    const patched = await service.patch(
      created.id,
      {
        agentic_config: {
          agent: 'opencode',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      },
      { user: owner } as never
    );

    expect(patched.agentic_config?.presetId).toBe(USER_DEFAULT_AGENTIC_CONFIGURATION);
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(raw).toBeDefined();
    expect(raw?.agentic_tool_preset_id).toBeNull();
    expect((raw?.agentic_config as Record<string, unknown> | undefined)?.presetId).toBe(
      USER_DEFAULT_AGENTIC_CONFIGURATION
    );
  });

  dbTest('stores a real preset only in the preset FK', async ({ db }) => {
    const { data, owner } = await channelData(db);
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'opencode',
        name: 'Gateway preset',
        configuration: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-preset' },
        },
      },
      owner.user_id
    );
    const created = await new GatewayChannelsService(db).create(
      {
        ...data,
        agentic_config: { agent: 'opencode', presetId: preset.preset_id },
      },
      { user: owner } as never
    );

    expect(created.agentic_config?.presetId).toBe(preset.preset_id);
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(raw).toBeDefined();
    expect(raw?.agentic_tool_preset_id).toBe(preset.preset_id);
    expect((raw?.agentic_config as Record<string, unknown> | undefined)?.presetId).toBeUndefined();
  });
});

async function channelData(db: TenantScopeAwareDatabase, withOpenCodeDefault = false) {
  const owner = await new UsersRepository(db).create({
    email: `gateway-owner-${generateId()}@example.com`,
    name: 'Gateway owner',
    ...(withOpenCodeDefault
      ? {
          default_agentic_config: {
            opencode: {
              modelConfig: {
                mode: 'exact' as const,
                provider: 'openai',
                model: 'gpt-test',
              },
            },
          },
        }
      : {}),
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `gateway-channel-${generateId()}`,
    name: 'Gateway channel test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'gateway-channel-test',
    ref: 'gateway-channel-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: owner.user_id,
  });
  const data = {
    name: 'OpenCode channel',
    channel_type: 'slack' as const,
    target_branch_id: branch.branch_id,
    agor_user_id: owner.user_id,
    config: {},
    agentic_config: { agent: 'opencode' as const },
    enabled: false,
  };
  return { data, owner };
}
