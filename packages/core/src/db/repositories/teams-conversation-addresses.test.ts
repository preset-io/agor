import type { GatewayChannel } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { teamsAddressRevocationFromActivity } from '../../gateway/connectors/teams-address-events';
import type { Database } from '../client';
import { runDatabaseTransaction, update } from '../database-wrapper';
import { teamsConversationAddresses } from '../schema';
import { ownedDbTest } from '../test-helpers';
import { GatewayChannelRepository } from './gateway-channels';
import {
  type TeamsConversationAddressInput,
  TeamsConversationAddressRepository,
  TeamsServiceUrlNotAllowedError,
} from './teams-conversation-addresses';
import { seedTeamsGateway, TEAMS_MICROSOFT_TENANT } from './teams-gateway-ha.test-support';

const APP_ID = 'teams-app-id';

async function seedChannel(db: Database): Promise<GatewayChannel> {
  return (await seedTeamsGateway(db, { appId: APP_ID })).channel;
}

function input(
  channel: GatewayChannel,
  overrides: Partial<TeamsConversationAddressInput> = {}
): TeamsConversationAddressInput {
  return {
    gatewayChannelId: channel.id,
    threadId: '19:general@thread.tacv2|root-1',
    conversationId: '19:general@thread.tacv2',
    rootMessageId: 'root-1',
    teamId: '19:general@thread.tacv2',
    address: {
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversation: { id: '19:general@thread.tacv2;messageid=root-1' },
    },
    verifiedAppId: APP_ID,
    verifiedTenantId: TEAMS_MICROSOFT_TENANT,
    providerConfigGeneration: channel.provider_config_generation,
    ...overrides,
  };
}

describe('TeamsConversationAddressRepository', () => {
  const priorSecret = process.env.AGOR_MASTER_SECRET;
  beforeAll(() => {
    process.env.AGOR_MASTER_SECRET = 'teams-address-test-secret';
  });
  afterAll(() => {
    if (priorSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = priorSecret;
  });

  ownedDbTest(
    'keeps an address usable 25 hours after the last inbound activity',
    async ({ db }) => {
      const channel = await seedChannel(db);
      const addresses = new TeamsConversationAddressRepository(db);
      const stored = await addresses.refresh(input(channel));
      await update(db, teamsConversationAddresses)
        .set({ refreshed_at: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(teamsConversationAddresses.address_id, stored.address_id))
        .run();
      const fenced = await addresses.loadFenced({ channel, threadId: input(channel).threadId });
      expect(fenced).toMatchObject({
        ok: true,
        address: { serviceUrl: 'https://smba.trafficmanager.net/emea/' },
      });
    }
  );

  ownedDbTest(
    'keeps addresses usable across a non-credential edit but not a tenant change',
    async ({ db }) => {
      const channel = await seedChannel(db);
      const addresses = new TeamsConversationAddressRepository(db);
      await addresses.refresh(input(channel));
      const channels = new GatewayChannelRepository(db);
      const edited = await channels.updateWithVerifiedProviderInstallation(
        channel.id,
        { config: { ...channel.config, allowed_user_aad_object_ids: ['someone-else'] } },
        APP_ID,
        channel.provider_config_generation
      );
      expect(edited.provider_config_generation).toBeGreaterThan(channel.provider_config_generation);
      expect(
        await addresses.loadFenced({
          channel: edited,
          threadId: input(channel).threadId,
          expected: { provider_installation_id: APP_ID },
        })
      ).toMatchObject({ ok: true });
      const otherTenant = await channels.updateWithVerifiedProviderInstallation(
        channel.id,
        { config: { ...edited.config, microsoft_tenant_id: 'other-entra-tenant' } },
        APP_ID,
        edited.provider_config_generation
      );
      expect(
        await addresses.loadFenced({ channel: otherTenant, threadId: input(channel).threadId })
      ).toEqual({ ok: false, code: 'conversation_address_stale' });
    }
  );

  ownedDbTest('refuses a non-allowlisted service URL at upsert', async ({ db }) => {
    const channel = await seedChannel(db);
    const addresses = new TeamsConversationAddressRepository(db);
    await expect(
      runDatabaseTransaction(db, (tx) =>
        addresses.upsertInTransaction(
          tx,
          input(channel, { address: { serviceUrl: 'https://attacker.example/' } })
        )
      )
    ).rejects.toThrow(TeamsServiceUrlNotAllowedError);
    expect(await addresses.findByChannelAndThread(channel.id, input(channel).threadId)).toBeNull();
  });

  ownedDbTest(
    'revokes on a removal event until the next verified activity re-arms it',
    async ({ db }) => {
      const channel = await seedChannel(db);
      const addresses = new TeamsConversationAddressRepository(db);
      await addresses.refresh(input(channel));
      await addresses.refresh(
        input(channel, {
          threadId: '19:design@thread.tacv2|root-9',
          conversationId: '19:design@thread.tacv2',
          rootMessageId: 'root-9',
        })
      );
      const removal = teamsAddressRevocationFromActivity(
        {
          type: 'conversationUpdate',
          conversation: { id: '19:general@thread.tacv2' },
          channelData: { team: { id: '19:general@thread.tacv2' } },
          membersRemoved: [{ id: `28:${APP_ID}` }],
        },
        APP_ID
      );
      if (!removal) throw new Error('removal was not classified');
      expect(await addresses.revokeForEvent(channel.id, removal)).toBeGreaterThanOrEqual(2);
      for (const threadId of ['19:general@thread.tacv2|root-1', '19:design@thread.tacv2|root-9']) {
        expect(await addresses.loadFenced({ channel, threadId })).toEqual({
          ok: false,
          code: 'conversation_address_revoked',
        });
      }
      await addresses.refresh(input(channel));
      expect(
        await addresses.loadFenced({ channel, threadId: '19:general@thread.tacv2|root-1' })
      ).toMatchObject({ ok: true });
    }
  );

  ownedDbTest('suspends on BotDisabledByAdmin and revokes by conversation id', async ({ db }) => {
    const channel = await seedChannel(db);
    const addresses = new TeamsConversationAddressRepository(db);
    await addresses.refresh(input(channel));
    await addresses.revokeThread(channel.id, input(channel).threadId, 'bot_disabled');
    expect(await addresses.loadFenced({ channel, threadId: input(channel).threadId })).toEqual({
      ok: false,
      code: 'conversation_address_suspended',
    });
    await addresses.refresh(input(channel));
    expect(await addresses.revokeConversations(channel.id, ['19:general@thread.tacv2'])).toBe(1);
    expect(await addresses.loadFenced({ channel, threadId: input(channel).threadId })).toEqual({
      ok: false,
      code: 'conversation_address_revoked',
    });
  });

  ownedDbTest(
    'keeps the team group ID and channel type when a later activity omits them',
    async ({ db }) => {
      const channel = await seedChannel(db);
      const addresses = new TeamsConversationAddressRepository(db);
      const groupId = 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b';
      await addresses.refresh(
        input(channel, { teamAadGroupId: groupId, teamsChannelType: 'standard' })
      );
      const refreshed = await addresses.refresh(input(channel));
      expect(refreshed).toMatchObject({
        team_aad_group_id: groupId,
        teams_channel_type: 'standard',
      });
    }
  );

  ownedDbTest('finds the newest usable address in a channel conversation', async ({ db }) => {
    const channel = await seedChannel(db);
    const addresses = new TeamsConversationAddressRepository(db);
    await addresses.refresh(input(channel));
    await addresses.refresh(
      input(channel, { threadId: '19:general@thread.tacv2|root-2', rootMessageId: 'root-2' })
    );
    await addresses.revokeThread(channel.id, '19:general@thread.tacv2|root-2', 'bot_removed');
    const found = await addresses.loadFencedByConversation({
      channel,
      conversationId: '19:general@thread.tacv2',
    });
    expect(found).toMatchObject({ ok: true, row: { thread_id: input(channel).threadId } });
    expect(
      await addresses.loadFencedByConversation({
        channel,
        conversationId: '19:unseen@thread.tacv2',
      })
    ).toEqual({ ok: false, code: 'conversation_address_missing' });
    const other = (await seedTeamsGateway(db, { appId: 'other-app' })).channel;
    expect(
      await addresses.loadFencedByConversation({
        channel: other,
        conversationId: '19:general@thread.tacv2',
      })
    ).toEqual({ ok: false, code: 'conversation_address_missing' });
  });

  ownedDbTest(
    'refuses a conversation any of whose threads Teams marked private',
    async ({ db }) => {
      const channel = await seedChannel(db);
      const addresses = new TeamsConversationAddressRepository(db);
      await addresses.refresh(input(channel, { teamsChannelType: 'private' }));
      await addresses.refresh(
        input(channel, { threadId: '19:general@thread.tacv2|root-2', rootMessageId: 'root-2' })
      );
      expect(
        await addresses.loadFencedByConversation({
          channel,
          conversationId: '19:general@thread.tacv2',
        })
      ).toEqual({ ok: false, code: 'conversation_not_standard_channel' });
      expect(await addresses.loadFencedTeamAnchors({ channel, limit: 5 })).toEqual([
        expect.objectContaining({
          row: expect.objectContaining({ thread_id: '19:general@thread.tacv2|root-2' }),
        }),
      ]);
    }
  );
});
