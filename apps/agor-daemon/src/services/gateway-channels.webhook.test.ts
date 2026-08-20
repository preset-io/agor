import {
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
} from '@agor/core/db';
import { type BranchID, GATEWAY_REDACTED_SENTINEL, type UUID } from '@agor/core/types';
import { beforeAll, describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { GatewayChannelsService } from './gateway-channels';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-webhook-test-secret';
});

describe('GatewayChannelsService webhook configuration', () => {
  dbTest(
    'validates webhook templates and authentication settings before persistence',
    async ({ db }) => {
      const { data, owner } = await webhookChannelData(db);
      const service = new GatewayChannelsService(db);

      await expect(
        service.create({ ...data, config: { webhook_secret: 'secret' } }, { user: owner } as never)
      ).rejects.toThrow(/prompt_template is required/i);
      await expect(
        service.create(
          {
            ...data,
            config: {
              prompt_template: '{{payload}}',
              webhook_secret: 'secret',
              header_name: 'authorization',
            },
          },
          { user: owner } as never
        )
      ).rejects.toThrow(/safe HTTP header name/i);
      await expect(
        service.create(
          {
            ...data,
            config: {
              prompt_template: '{{payload}}',
              webhook_secret: 'secret',
              auth_mode: 'hmac-sha256',
              replay_window_seconds: 10,
            },
          },
          { user: owner } as never
        )
      ).rejects.toThrow(/between 30 and 86400/i);

      expect(await new GatewayChannelRepository(db).findAll()).toHaveLength(0);
    }
  );

  dbTest('requires the webhook secret only when the channel is enabled', async ({ db }) => {
    const { data, owner } = await webhookChannelData(db);
    const service = new GatewayChannelsService(db);

    await expect(service.create(data, { user: owner } as never)).rejects.toThrow(
      /missing required secret\(s\) webhook_secret/i
    );

    const draft = await service.create({ ...data, enabled: false }, { user: owner } as never);
    await expect(
      service.patch(draft.id, { enabled: true }, { user: owner } as never)
    ).rejects.toThrow(/missing required secret\(s\) webhook_secret/i);

    const enabled = await service.patch(
      draft.id,
      { config: { webhook_secret: 'activate-secret' }, enabled: true },
      { user: owner } as never
    );
    expect(enabled.enabled).toBe(true);
  });

  dbTest('creates an opaque endpoint and encrypts the webhook secret at rest', async ({ db }) => {
    const { data, owner } = await webhookChannelData(db);
    const created = await new GatewayChannelsService(db).create(
      { ...data, config: { ...data.config, webhook_secret: 'top-secret' } },
      { user: owner } as never
    );

    expect(created.webhook_endpoint_id).toMatch(/^[a-f0-9-]{60,}$/);
    expect(created.webhook_endpoint_id).not.toBe(created.channel_key);
    expect(created.config.webhook_secret).toBe('top-secret');

    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(raw?.webhook_endpoint_id).toBe(created.webhook_endpoint_id);
    expect(isEncrypted(String(raw?.config.webhook_secret))).toBe(true);
  });

  dbTest(
    'merges config patches, preserves a redacted secret, and rejects invalid updates',
    async ({ db }) => {
      const { data, owner } = await webhookChannelData(db);
      const service = new GatewayChannelsService(db);
      const created = await service.create(
        {
          ...data,
          config: { ...data.config, webhook_secret: 'stored-secret', header_name: 'x-hook-token' },
        },
        { user: owner } as never
      );

      const patched = await service.patch(
        created.id,
        {
          config: {
            webhook_secret: GATEWAY_REDACTED_SENTINEL,
            prompt_template: 'Event: {{payload.event}}',
          },
        },
        { user: owner } as never
      );
      expect(patched.config).toMatchObject({
        webhook_secret: 'stored-secret',
        header_name: 'x-hook-token',
        prompt_template: 'Event: {{payload.event}}',
      });
      expect(patched.webhook_endpoint_id).toBe(created.webhook_endpoint_id);

      await expect(
        service.patch(created.id, { config: { prompt_template: '{{process.env.SECRET}}' } }, {
          user: owner,
        } as never)
      ).rejects.toThrow(/unsupported webhook template expression/i);
      expect((await service.get(created.id)).config.prompt_template).toBe(
        'Event: {{payload.event}}'
      );
    }
  );
});

async function webhookChannelData(db: TenantScopeAwareDatabase) {
  const owner = await new UsersRepository(db).create({
    email: `webhook-owner-${generateId()}@example.com`,
    name: 'Webhook owner',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `webhook-channel-${generateId()}`,
    name: 'Webhook channel test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'webhook-channel-test',
    ref: 'webhook-channel-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: owner.user_id,
  });
  return {
    owner,
    data: {
      name: 'Inbound webhook',
      channel_type: 'webhook' as const,
      target_branch_id: branch.branch_id,
      agor_user_id: owner.user_id,
      config: { prompt_template: 'Payload: {{payload}}' },
    },
  };
}
