import type { BranchID, Message, MessageID, SessionID, UUID } from '@agor/core/types';
import { MessageRole, SessionStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { runDatabaseTransaction, update } from '../database-wrapper';
import { discordMessageDeliveries } from '../schema';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { DiscordMessageDeliveryRepository } from './discord-message-deliveries';
import { GatewayChannelRepository } from './gateway-channels';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { ThreadSessionMapRepository } from './thread-session-map';

const discordConfig = {
  bot_token: 'discord-token',
  application_id: '666666666666666666',
  guild_id: '222222222222222222',
  allowed_channel_ids: ['333333333333333333'],
  allowed_user_ids: ['444444444444444444'],
  allowed_role_ids: [],
  message_content_enabled: true,
  thread_mode: 'public_thread_per_summon' as const,
  align_discord_users: false,
  files: false as const,
  agent_tools: [] as never[],
};

async function seedMappedDiscord(db: Database, metadata: Record<string, unknown> = {}) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `delivery/${generateId()}`,
    name: 'Delivery test repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/delivery.git',
    local_path: '/tmp/delivery-test-repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/tmp/delivery-test-repo/main',
    created_by: 'test-user' as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id as BranchID,
    created_by: generateId() as UUID,
    status: SessionStatus.IDLE,
    title: 'Delivery session',
    tasks: [],
  });
  const channels = new GatewayChannelRepository(db);
  const draft = await channels.create({
    name: 'Mapped Discord',
    created_by: generateId() as UUID,
    target_branch_id: branch.branch_id as UUID,
    channel_type: 'discord',
    enabled: false,
    config: discordConfig,
  });
  const channel = await channels.updateWithVerifiedDiscordInstallation(
    draft.id,
    { enabled: true, agor_user_id: generateId() as UUID },
    discordConfig.application_id,
    draft.provider_config_generation
  );
  const mapping = await new ThreadSessionMapRepository(db).create({
    channel_id: channel.id,
    thread_id: 'discord:message:333333333333333333:888888888888888888',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    metadata,
  });
  return { channel, mapping, session };
}

function assistantMessage(sessionId: SessionID, overrides: Partial<Message> = {}): Message {
  return {
    message_id: generateId() as MessageID,
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp: new Date().toISOString(),
    content_preview: 'A durable reply',
    content: 'A durable reply',
    ...overrides,
  };
}

async function createDelivery(db: Database) {
  const { mapping, session } = await seedMappedDiscord(db);
  const deliveries = new DiscordMessageDeliveryRepository(db);
  const messages = new MessagesRepository(db, (tx, message) =>
    deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
  );
  const message = await messages.create(assistantMessage(session.session_id));
  const delivery = await deliveries.findByMessageId(message.message_id);
  if (!delivery) throw new Error('test delivery was not created');
  return { delivery, deliveries, mapping };
}

describe('DiscordMessageDeliveryRepository', () => {
  dbTest(
    'enqueues exactly once in the Message transaction and preserves canonical text outside the intent',
    async ({ db }) => {
      const { mapping, session } = await seedMappedDiscord(db);
      const deliveries = new DiscordMessageDeliveryRepository(db);
      const messages = new MessagesRepository(db, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );

      const message = await messages.create(assistantMessage(session.session_id));
      const first = await deliveries.findByMessageId(message.message_id);
      expect(first).toMatchObject({
        message_id: message.message_id,
        gateway_channel_id: mapping.channel_id,
        thread_session_map_id: mapping.id,
        status: 'pending',
        chunk_receipts: [],
        reply_aliases: [],
      });
      expect(JSON.stringify(first)).not.toContain('A durable reply');

      await runDatabaseTransaction(db, async (tx) => {
        await deliveries.enqueueForMessageInTransaction(tx, message);
        await deliveries.enqueueForMessageInTransaction(tx, message);
      });
      expect(await deliveries.findByMessageId(message.message_id)).toMatchObject({
        delivery_id: first?.delivery_id,
      });
    }
  );

  dbTest('rolls back the Message when durable intent insertion fails', async ({ db }) => {
    const { session } = await seedMappedDiscord(db);
    const message = assistantMessage(session.session_id);
    const messages = new MessagesRepository(db, async () => {
      throw new Error('delivery insert failed');
    });

    await expect(messages.create(message)).rejects.toThrow('delivery insert failed');
    expect(await new MessagesRepository(db).findById(message.message_id)).toBeNull();
  });

  dbTest(
    'does not enqueue non-routable assistant variants or proactive seed mappings',
    async ({ db }) => {
      const deliveries = new DiscordMessageDeliveryRepository(db);
      const { session: mappedSession, mapping: mappedMapping } = await seedMappedDiscord(db);
      const messages = new MessagesRepository(db, (tx, message) =>
        deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
      );

      const user = await messages.create(
        assistantMessage(mappedSession.session_id, {
          role: MessageRole.USER,
          type: 'user',
        })
      );
      const thinking = await messages.create(
        assistantMessage(mappedSession.session_id, {
          content: 'Thinking...',
          content_preview: 'Thinking...',
        })
      );
      expect(await deliveries.findByMessageId(user.message_id)).toBeNull();
      expect(await deliveries.findByMessageId(thinking.message_id)).toBeNull();

      const mappings = new ThreadSessionMapRepository(db);
      await mappings.update(mappedMapping.id, { metadata: { outbound_seed_id: generateId() } });
      const proactive = await messages.create(assistantMessage(mappedSession.session_id));
      expect(await deliveries.findByMessageId(proactive.message_id)).toBeNull();
    }
  );

  dbTest(
    'fences competing claims and merges bounded receipts with aliases exactly once',
    async ({ db }) => {
      const { delivery, deliveries, mapping } = await createDelivery(db);
      const now = new Date();
      const [first, second] = await Promise.all([
        deliveries.claim(delivery.delivery_id, 'claim-a', 30_000, now),
        deliveries.claim(delivery.delivery_id, 'claim-b', 30_000, now),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const winner = first ?? second;
      if (!winner) throw new Error('test claim did not win');
      const staleToken = winner.claim_token === 'claim-a' ? 'claim-b' : 'claim-a';

      await expect(
        deliveries.checkpointChunk({
          deliveryId: delivery.delivery_id,
          claimToken: staleToken,
          claimGeneration: winner.claim_generation,
          receipt: {
            chunk_index: 0,
            nonce: 'wrong-claim',
            provider_message_id: 'provider-wrong',
            reply_aliases: [],
          },
          now,
        })
      ).rejects.toThrow('claim was lost');

      await expect(
        deliveries.completeClaim({
          deliveryId: delivery.delivery_id,
          claimToken: staleToken,
          claimGeneration: winner.claim_generation,
          now,
        })
      ).rejects.toThrow('claim was lost');

      // A receipt is only accepted after the provider-effect marker is
      // durably fenced under the same claim.
      await deliveries.markChunkEffectStarted({
        deliveryId: delivery.delivery_id,
        claimToken: winner.claim_token,
        claimGeneration: winner.claim_generation,
        chunkIndex: 0,
        now,
      });
      await deliveries.checkpointChunk({
        deliveryId: delivery.delivery_id,
        claimToken: winner.claim_token,
        claimGeneration: winner.claim_generation,
        receipt: {
          chunk_index: 0,
          nonce: 'nonce-0',
          provider_message_id: 'provider-0',
          reply_aliases: ['discord:message:333333333333333333:777777777777777777'],
        },
        now,
      });
      const completed = await deliveries.completeClaim({
        deliveryId: delivery.delivery_id,
        claimToken: winner.claim_token,
        claimGeneration: winner.claim_generation,
        now,
      });
      expect(completed.status).toBe('completed');
      expect(
        (await new ThreadSessionMapRepository(db).findById(mapping.id))?.metadata
      ).not.toHaveProperty('gateway_last_message_id');
      expect(
        (await new ThreadSessionMapRepository(db).findById(mapping.id))?.metadata
      ).not.toHaveProperty('gateway_reply_aliases');
      await expect(
        deliveries.completeClaim({
          deliveryId: delivery.delivery_id,
          claimToken: winner.claim_token,
          claimGeneration: winner.claim_generation,
          now,
        })
      ).rejects.toThrow('claim was lost');
    }
  );

  dbTest(
    'discovers only tenant/delivery identity and enforces completed retention',
    async ({ db }) => {
      const { delivery, deliveries } = await createDelivery(db);
      const now = new Date();
      await expect(deliveries.findDueRefs(db, { now })).resolves.toEqual([
        {
          tenant_id: 'default',
          delivery_id: delivery.delivery_id,
          thread_session_map_id: delivery.thread_session_map_id,
        },
      ]);

      const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      await update(db, discordMessageDeliveries)
        .set({ status: 'completed', updated_at: old, completed_at: old })
        .where(eq(discordMessageDeliveries.delivery_id, delivery.delivery_id))
        .run();
      await expect(deliveries.purgeExpired(now)).resolves.toBe(1);
      await expect(deliveries.findById(delivery.delivery_id)).resolves.toBeNull();
    }
  );
});
