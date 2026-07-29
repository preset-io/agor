import {
  AgenticToolPresetRepository,
  BranchRepository,
  eq,
  GatewayChannelRepository,
  gatewayChannels,
  generateId,
  RepoRepository,
  select,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, BranchID, GatewayChannel, UserID, UUID } from '@agor/core/types';
import { USER_DEFAULT_AGENTIC_CONFIGURATION } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { GatewayChannelsService } from './gateway-channels';

const service = new GatewayChannelsService({} as TenantScopeAwareDatabase);

describe('GatewayChannelsService agentic configuration intent', () => {
  it('rejects a reference mixed with inline values', async () => {
    await expect(
      service.create({
        agor_user_id: 'user-1',
        config: {},
        agentic_config: {
          agent: 'codex',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
          permissionMode: 'ask',
        } as unknown as GatewayChannel['agentic_config'],
      })
    ).rejects.toThrow('Referenced gateway channels cannot contain inline values');
  });

  dbTest('rejects an incomplete inline OpenCode selection', async ({ db }) => {
    const { data } = await channelContext(db, false);

    await expect(
      new GatewayChannelsService(db).create({
        ...data,
        agentic_config: {
          agent: 'opencode',
          modelConfig: { mode: 'exact', provider: 'openai' },
        } as unknown as GatewayChannel['agentic_config'],
      })
    ).rejects.toThrow(/select.*provider.*model/i);
  });

  it('rejects My default when execution-owner alignment is unstable', async () => {
    await expect(
      service.create({
        agor_user_id: 'fallback-user',
        config: { align_slack_users: true },
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      })
    ).rejects.toThrow('Gateway channels without a stable execution owner cannot use My default');
  });

  dbTest('persists and round-trips My default for a stable execution owner', async ({ db }) => {
    const { data, params } = await channelContext(db, false);
    const service = new GatewayChannelsService(db);

    const created = await service.create(
      {
        ...data,
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      },
      params
    );
    await service.patch(created.id, { name: 'Patched channel' });

    await expect(service.get(created.id)).resolves.toMatchObject({
      name: 'Patched channel',
      agentic_config: {
        agent: 'claude-code',
        presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      },
    });
    const stored = await select(db, {
      agentic_config: gatewayChannels.agentic_config,
      agentic_tool_preset_id: gatewayChannels.agentic_tool_preset_id,
    })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(stored).toMatchObject({
      agentic_config: {
        agent: 'claude-code',
        presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      },
      agentic_tool_preset_id: null,
    });
  });

  dbTest('keeps concrete presets in the foreign key', async ({ db }) => {
    const { data, owner, params } = await channelContext(db, false);
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'claude-code',
        name: 'Gateway preset',
        configuration: {},
      },
      owner.user_id as UserID
    );
    const service = new GatewayChannelsService(db);

    const created = await service.create(
      {
        ...data,
        agentic_config: {
          agent: 'claude-code',
          presetId: preset.preset_id,
        },
      },
      params
    );

    expect(created.agentic_config).toEqual({
      agent: 'claude-code',
      presetId: preset.preset_id,
    });
    const stored = await select(db, {
      agentic_config: gatewayChannels.agentic_config,
      agentic_tool_preset_id: gatewayChannels.agentic_tool_preset_id,
    })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(stored).toEqual({
      agentic_config: { agent: 'claude-code' },
      agentic_tool_preset_id: preset.preset_id,
    });
  });

  async function channelContext(db: TenantScopeAwareDatabase, withOpenCodeDefault: boolean) {
    const owner = await new UsersRepository(db).create({
      email: `gateway-owner-${generateId()}@example.com`,
      name: 'Gateway owner',
      ...(withOpenCodeDefault
        ? {
            default_agentic_config: {
              opencode: {
                modelConfig: {
                  mode: 'exact' as const,
                  provider: 'owner-provider',
                  model: 'owner-model',
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
      agor_user_id: owner.user_id as UserID,
      config: {},
      agentic_config: { agent: 'opencode' as const },
      enabled: false,
    };
    return { owner, data, params: { user: owner } as AuthenticatedParams };
  }

  dbTest('rejects an absent OpenCode pair after channel-owner resolution', async ({ db }) => {
    const { data } = await channelContext(db, false);
    const channels = new GatewayChannelRepository(db);

    await expect(new GatewayChannelsService(db).create(data)).rejects.toThrow(
      /select.*provider.*model/i
    );
    expect(await channels.findAll()).toHaveLength(0);
  });

  dbTest(
    'accepts an absent inline OpenCode pair resolved from the channel owner',
    async ({ db }) => {
      const { data, params } = await channelContext(db, true);

      const created = await new GatewayChannelsService(db).create(data, params);

      expect(created.agentic_config).toEqual({ agent: 'opencode' });
    }
  );
});
