/**
 * PostgreSQL integration for provider-action RLS, SKIP LOCKED claims, and
 * listener/config fencing.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDiscordDeliveryPlan } from '../gateway/connectors/discord-delivery';
import { generateId } from '../lib/ids';
import { type GatewayChannelID, type MessageID, MessageRole, type TenantID } from '../types';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  GatewayProviderActionRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from './repositories';
import { gatewayProviderActions } from './schema';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 8_000_000;

async function seedActionGraph(db: Database, tenantId: TenantID, messageCount = 1) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: 'Provider action HA',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `provider-action-${tenantId}-${generateId()}`,
      name: 'Provider action HA',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/provider-action.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'provider-action',
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const applicationId = String(BigInt(Date.now()) * 1_000_000n + BigInt(branchUnique));
    const botToken = `discord-token-${generateId()}`;
    const channels = new GatewayChannelRepository(scoped);
    const channel = await channels.create({
      id: generateId() as GatewayChannelID,
      name: 'Discord provider actions',
      channel_type: 'discord',
      created_by: user.user_id,
      agor_user_id: user.user_id,
      target_branch_id: branch.branch_id,
      channel_key: generateId(),
      enabled: true,
      config: {
        bot_token: botToken,
        application_id: applicationId,
        guild_id: '223456789012345678',
        allowed_channel_ids: ['323456789012345678'],
        align_discord_users: false,
      },
    });
    await channels.claimProviderInstallationIdentity({
      channelId: channel.id,
      channelType: 'discord',
      providerInstallationId: applicationId,
      expectedConfig: { application_id: applicationId, bot_token: botToken },
    });
    const verified = await channels.findById(channel.id);
    if (!verified) throw new Error('provider action channel disappeared');
    const session = await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: user.user_id,
    });
    const task = await new TaskRepository(scoped).create({
      task_id: generateId(),
      session_id: session.session_id,
      status: 'completed',
      full_prompt: 'provider action',
      message_range: {
        start_index: 0,
        end_index: messageCount,
        start_timestamp: new Date().toISOString(),
      },
      created_by: user.user_id,
    });
    const mapping = await new ThreadSessionMapRepository(scoped).create({
      id: generateId(),
      channel_id: verified.id,
      thread_id: `discord:${String(BigInt(applicationId) + 1n)}`,
      session_id: session.session_id,
      branch_id: branch.branch_id,
      status: 'active',
      metadata: {
        discord_application_id: applicationId,
        discord_guild_id: '223456789012345678',
        discord_parent_channel_id: '323456789012345678',
        discord_message_id: String(BigInt(applicationId) + 2n),
        discord_last_summon_message_id: String(BigInt(applicationId) + 4n),
        discord_last_delivered_message_id: String(BigInt(applicationId) + 4n),
      },
    });
    const messageRepo = new MessagesRepository(scoped);
    const messages = [];
    for (let index = 0; index < messageCount; index += 1) {
      messages.push(
        await messageRepo.create({
          message_id: generateId() as MessageID,
          session_id: session.session_id,
          task_id: task.task_id,
          type: 'assistant',
          role: MessageRole.ASSISTANT,
          index,
          timestamp: new Date().toISOString(),
          content_preview: `final ${index}`,
          content: `canonical final ${index}`,
        })
      );
    }
    return { applicationId, channels, channel: verified, mapping, session, task, messages, user };
  });
}

function enqueueInput(graph: Awaited<ReturnType<typeof seedActionGraph>>, messageIndex: number) {
  const message = graph.messages[messageIndex];
  return {
    kind: 'deliver_message' as const,
    channelId: graph.channel.id,
    idempotencyKey: `message:${message.message_id}`,
    mappingId: graph.mapping.id,
    sessionId: graph.session.session_id,
    taskId: graph.task.task_id,
    messageId: message.message_id,
    params: { operation: 'create' as const },
  };
}

function historyEnqueueInput(graph: Awaited<ReturnType<typeof seedActionGraph>>) {
  const metadata = graph.mapping.metadata as Record<string, string>;
  return {
    kind: 'discord_thread_history' as const,
    channelId: graph.channel.id,
    idempotencyKey: `discord_thread_history:${generateId()}`,
    mappingId: graph.mapping.id,
    sessionId: graph.session.session_id,
    params: {
      request_id: generateId(),
      initial_message_id: metadata.discord_message_id as never,
      through_message_id: metadata.discord_last_summon_message_id as never,
      limit: 50,
    },
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'gateway provider actions (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('claims distinct bounded rows with the production SKIP LOCKED path', async () => {
      const tenantId = `provider-actions-claim-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId, 2);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const actions = new GatewayProviderActionRepository(scoped);
        await actions.enqueue(enqueueInput(graph, 0));
        await actions.enqueue(enqueueInput(graph, 1));
        const listener = await new GatewayChannelRepository(scoped).claimListener({
          channelId: graph.channel.id,
          claimToken: 'listener-owner',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-owner',
          bootId: 'boot-owner',
        });
        if (listener.outcome !== 'claimed') throw new Error('listener was not claimed');
        const claims = await Promise.all(
          ['action-worker-a', 'action-worker-b'].map((actionClaimToken, index) =>
            actions.claimForListener({
              channelId: graph.channel.id,
              listenerClaimToken: listener.lease.claim_token,
              listenerGeneration: listener.lease.generation,
              actionClaimToken,
              leaseMs: 30_000,
              limit: 1,
              identity: { instanceId: `daemon-${index}`, bootId: `boot-${index}` },
            })
          )
        );
        expect(claims.flat()).toHaveLength(2);
        expect(new Set(claims.flat().map(({ id }) => id)).size).toBe(2);
      });
    });

    it('claims and expires a history RPC with database-time fencing', async () => {
      const tenantId = `provider-actions-history-expiry-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const actions = new GatewayProviderActionRepository(scoped);
        const queued = await actions.enqueue(historyEnqueueInput(graph));
        expect(Date.parse(queued.action.drop_after!) - Date.parse(queued.action.created_at)).toBe(
          60_000
        );
        const listener = await new GatewayChannelRepository(scoped).claimListener({
          channelId: graph.channel.id,
          claimToken: 'history-listener',
          leaseDurationMs: 30_000,
          instanceId: 'history-daemon',
          bootId: 'history-boot',
        });
        if (listener.outcome !== 'claimed') throw new Error('listener was not claimed');
        const [claim] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: listener.lease.claim_token,
          listenerGeneration: listener.lease.generation,
          actionClaimToken: 'history-action',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'history-daemon', bootId: 'history-boot' },
        });
        await update(scoped, gatewayProviderActions)
          .set({ drop_after: new Date(0) })
          .where(eq(gatewayProviderActions.id, claim.id))
          .run();
        await expect(
          actions.admitProviderCall({
            actionId: claim.id,
            channelId: graph.channel.id,
            actionClaimToken: claim.claim_token!,
            actionClaimGeneration: claim.claim_generation,
            listenerClaimToken: listener.lease.claim_token,
            listenerGeneration: listener.lease.generation,
            leaseMs: 30_000,
          })
        ).resolves.toBeNull();
        await expect(actions.findById(claim.id)).resolves.toMatchObject({
          status: 'canceled',
          last_error_code: 'discord_history_expired',
        });
      });
    });

    it('derives and claims notice expiry from database time despite process clock skew', async () => {
      const tenantId = `provider-actions-notice-clock-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const channels = new GatewayChannelRepository(scoped);
        const inbound = await new GatewayInboundEventRepository(scoped).claim({
          channelId: graph.channel.id,
          providerEventId: `discord:message:${graph.applicationId}:923456789012345677`,
          threadId: 'discord:923456789012345677',
          processingToken: 'notice-clock-event',
          leaseDurationMs: 30_000,
          requireListenerClaim: false,
        });
        if (inbound.outcome !== 'claimed') throw new Error('notice event was not claimed');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
        try {
          const actions = new GatewayProviderActionRepository(scoped);
          const queued = await actions.enqueue({
            kind: 'discord_notice',
            channelId: graph.channel.id,
            inboundEventId: inbound.event.id,
            idempotencyKey: `discord_notice:${inbound.event.id}:routing`,
            params: { notice_code: 'alignment_missing' },
          });
          expect(Date.parse(queued.action.drop_after!) - Date.parse(queued.action.created_at)).toBe(
            120_000
          );
          expect(Date.parse(queued.action.created_at)).toBeLessThan(
            Date.parse('2090-01-01T00:00:00.000Z')
          );
          const listener = await channels.claimListener({
            channelId: graph.channel.id,
            claimToken: 'notice-clock-listener',
            leaseDurationMs: 30_000,
            instanceId: 'notice-clock-daemon',
            bootId: 'notice-clock-boot',
          });
          if (listener.outcome !== 'claimed') throw new Error('listener was not claimed');
          await expect(
            actions.claimForListener({
              channelId: graph.channel.id,
              listenerClaimToken: listener.lease.claim_token,
              listenerGeneration: listener.lease.generation,
              actionClaimToken: 'notice-clock-action',
              leaseMs: 30_000,
              limit: 1,
              identity: { instanceId: 'notice-clock-daemon', bootId: 'notice-clock-boot' },
            })
          ).resolves.toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('denies cross-tenant reads, claims, and canonical-reference enqueue', async () => {
      const ownerTenant = `provider-actions-owner-${generateId()}` as TenantID;
      const otherTenant = `provider-actions-other-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, ownerTenant);
      const otherGraph = await seedActionGraph(db, otherTenant);
      const repairIdentity = createDiscordDeliveryPlan(
        'canonical final 0',
        graph.messages[0].message_id
      ).metadata;
      const { action, history, notice, progress } = await runWithTenantDatabaseScope(
        db,
        ownerTenant,
        async (scoped) => {
          const actions = new GatewayProviderActionRepository(scoped);
          const action = (await actions.enqueue(enqueueInput(graph, 0))).action;
          const history = (await actions.enqueue(historyEnqueueInput(graph))).action;
          const listener = await new GatewayChannelRepository(scoped).claimListener({
            channelId: graph.channel.id,
            claimToken: 'repair-listener',
            leaseDurationMs: 30_000,
            instanceId: 'repair-daemon',
            bootId: 'repair-boot',
          });
          if (listener.outcome !== 'claimed') throw new Error('repair listener was not claimed');
          const [claim] = await actions.claimForListener({
            channelId: graph.channel.id,
            listenerClaimToken: listener.lease.claim_token,
            listenerGeneration: listener.lease.generation,
            actionClaimToken: 'repair-action',
            leaseMs: 30_000,
            limit: 1,
            identity: { instanceId: 'repair-daemon', bootId: 'repair-boot' },
          });
          await actions.initializeDiscordDelivery({
            actionId: claim.id,
            channelId: graph.channel.id,
            actionClaimToken: claim.claim_token!,
            actionClaimGeneration: claim.claim_generation,
            listenerClaimToken: listener.lease.claim_token,
            listenerGeneration: listener.lease.generation,
            metadata: repairIdentity,
          });
          await actions.deadLetter({
            actionId: claim.id,
            channelId: graph.channel.id,
            actionClaimToken: claim.claim_token!,
            actionClaimGeneration: claim.claim_generation,
            listenerClaimToken: listener.lease.claim_token,
            listenerGeneration: listener.lease.generation,
            errorCode: 'discord_nonce_recovery_incomplete',
          });
          const progress = await actions.enqueueDiscordProgress({
            channelId: graph.channel.id,
            mappingId: graph.mapping.id,
            sessionId: graph.session.session_id,
            taskId: graph.task.task_id,
            state: 'done',
            dropAfterMs: 60_000,
          });
          if (progress.outcome === 'ignored') throw new Error('progress was unexpectedly ignored');
          const inbound = await new GatewayInboundEventRepository(scoped).claim({
            channelId: graph.channel.id,
            providerEventId: `discord:message:${graph.applicationId}:923456789012345678`,
            threadId: 'discord:923456789012345678',
            processingToken: listener.lease.claim_token,
            leaseDurationMs: 30_000,
            requireListenerClaim: true,
          });
          if (inbound.outcome !== 'claimed') throw new Error('notice event was not claimed');
          const notice = await actions.enqueue({
            kind: 'discord_notice',
            channelId: graph.channel.id,
            inboundEventId: inbound.event.id,
            idempotencyKey: `discord_notice:${inbound.event.id}:routing`,
            params: { notice_code: 'alignment_missing' },
          });
          return { action, history, notice: notice.action, progress: progress.action };
        }
      );
      await runWithTenantDatabaseScope(db, otherTenant, async (scoped) => {
        const actions = new GatewayProviderActionRepository(scoped);
        await expect(actions.findById(action.id)).resolves.toBeNull();
        await expect(actions.findById(history.id)).resolves.toBeNull();
        await expect(actions.findById(progress.id)).resolves.toBeNull();
        await expect(actions.findById(notice.id)).resolves.toBeNull();
        await expect(actions.countBacklog(graph.channel.id)).resolves.toBe(0);
        await expect(
          actions.abandonDiscordDelivery({
            actionId: action.id,
            channelId: graph.channel.id,
            operatorUserId: otherGraph.user.user_id,
            expectedMetadata: repairIdentity,
          })
        ).resolves.toBe(false);
        await expect(
          actions.repairDiscordDeliveryCoordinates({
            actionId: action.id,
            channelId: graph.channel.id,
            operatorUserId: otherGraph.user.user_id,
            expectedMetadata: repairIdentity,
            providerMessageIds: repairIdentity.chunks.map((_, index) =>
              String(923456789012345678n + BigInt(index))
            ),
          })
        ).resolves.toBe(false);
        await expect(actions.enqueue(enqueueInput(graph, 0))).rejects.toThrow(
          /not outbound-authorized/
        );
      });
    });

    it('reclaims death after provider-call admission and fences stale completion', async () => {
      const tenantId = `provider-actions-takeover-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const channels = new GatewayChannelRepository(scoped);
        const actions = new GatewayProviderActionRepository(scoped);
        await actions.enqueue(enqueueInput(graph, 0));
        const oldListener = await channels.claimListener({
          channelId: graph.channel.id,
          claimToken: 'old-listener',
          leaseDurationMs: 30_000,
          instanceId: 'old-daemon',
          bootId: 'old-boot',
        });
        if (oldListener.outcome !== 'claimed') throw new Error('old listener was not claimed');
        const [oldClaim] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: oldListener.lease.claim_token,
          listenerGeneration: oldListener.lease.generation,
          actionClaimToken: 'old-action',
          leaseMs: 1,
          limit: 1,
          identity: { instanceId: 'old-daemon', bootId: 'old-boot' },
        });
        await expect(
          actions.admitProviderCall({
            actionId: oldClaim.id,
            channelId: graph.channel.id,
            actionClaimToken: oldClaim.claim_token!,
            actionClaimGeneration: oldClaim.claim_generation,
            listenerClaimToken: oldListener.lease.claim_token,
            listenerGeneration: oldListener.lease.generation,
            leaseMs: 1,
          })
        ).resolves.toMatchObject({ id: oldClaim.id });
        const plan = createDiscordDeliveryPlan('canonical final 0', graph.messages[0].message_id);
        await expect(
          actions.initializeDiscordDelivery({
            actionId: oldClaim.id,
            channelId: graph.channel.id,
            actionClaimToken: oldClaim.claim_token!,
            actionClaimGeneration: oldClaim.claim_generation,
            listenerClaimToken: oldListener.lease.claim_token,
            listenerGeneration: oldListener.lease.generation,
            metadata: plan.metadata,
          })
        ).resolves.toMatchObject({ outcome: 'initialized' });
        await channels.releaseListener(graph.channel.id, oldListener.lease.claim_token);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const takeover = await channels.claimListener({
          channelId: graph.channel.id,
          claimToken: 'new-listener',
          leaseDurationMs: 30_000,
          instanceId: 'new-daemon',
          bootId: 'new-boot',
        });
        if (takeover.outcome !== 'claimed') throw new Error('takeover was not claimed');
        const [reclaimed] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: takeover.lease.claim_token,
          listenerGeneration: takeover.lease.generation,
          actionClaimToken: 'new-action',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'new-daemon', bootId: 'new-boot' },
        });
        expect(reclaimed).toMatchObject({
          id: oldClaim.id,
          claim_generation: oldClaim.claim_generation + 1,
        });
        await expect(
          actions.admitProviderCall({
            actionId: reclaimed.id,
            channelId: graph.channel.id,
            actionClaimToken: reclaimed.claim_token!,
            actionClaimGeneration: reclaimed.claim_generation,
            listenerClaimToken: takeover.lease.claim_token,
            listenerGeneration: takeover.lease.generation,
            leaseMs: 30_000,
          })
        ).resolves.toMatchObject({ id: oldClaim.id });
        await expect(
          actions.complete({
            actionId: oldClaim.id,
            channelId: graph.channel.id,
            actionClaimToken: oldClaim.claim_token!,
            actionClaimGeneration: oldClaim.claim_generation,
            listenerClaimToken: oldListener.lease.claim_token,
            listenerGeneration: oldListener.lease.generation,
            result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
          })
        ).resolves.toBe(false);
        await expect(
          actions.recordDiscordDeliveryChunk({
            actionId: oldClaim.id,
            channelId: graph.channel.id,
            actionClaimToken: oldClaim.claim_token!,
            actionClaimGeneration: oldClaim.claim_generation,
            listenerClaimToken: oldListener.lease.claim_token,
            listenerGeneration: oldListener.lease.generation,
            expectedMetadata: plan.metadata,
            chunkIndex: 0,
            providerMessageId: '523456789012345678',
          })
        ).resolves.toEqual({ outcome: 'fenced' });
        await expect(
          actions.recordDiscordDeliveryChunk({
            actionId: reclaimed.id,
            channelId: graph.channel.id,
            actionClaimToken: reclaimed.claim_token!,
            actionClaimGeneration: reclaimed.claim_generation,
            listenerClaimToken: takeover.lease.claim_token,
            listenerGeneration: takeover.lease.generation,
            expectedMetadata: plan.metadata,
            chunkIndex: 0,
            providerMessageId: '523456789012345678',
          })
        ).resolves.toMatchObject({ outcome: 'recorded' });
        await expect(
          actions.complete({
            actionId: reclaimed.id,
            channelId: graph.channel.id,
            actionClaimToken: reclaimed.claim_token!,
            actionClaimGeneration: reclaimed.claim_generation,
            listenerClaimToken: takeover.lease.claim_token,
            listenerGeneration: takeover.lease.generation,
            result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
          })
        ).resolves.toBe(true);
      });
    });

    it('lets only the takeover owner admit a call after death before REST', async () => {
      const tenantId = `provider-actions-before-rest-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const channels = new GatewayChannelRepository(scoped);
        const actions = new GatewayProviderActionRepository(scoped);
        await actions.enqueue(enqueueInput(graph, 0));
        const oldListener = await channels.claimListener({
          channelId: graph.channel.id,
          claimToken: 'before-rest-old-listener',
          leaseDurationMs: 30_000,
          instanceId: 'old-daemon',
          bootId: 'old-boot',
        });
        if (oldListener.outcome !== 'claimed') throw new Error('old listener was not claimed');
        const [oldClaim] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: oldListener.lease.claim_token,
          listenerGeneration: oldListener.lease.generation,
          actionClaimToken: 'before-rest-old-action',
          leaseMs: 1,
          limit: 1,
          identity: { instanceId: 'old-daemon', bootId: 'old-boot' },
        });
        await channels.releaseListener(graph.channel.id, oldListener.lease.claim_token);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const takeover = await channels.claimListener({
          channelId: graph.channel.id,
          claimToken: 'before-rest-new-listener',
          leaseDurationMs: 30_000,
          instanceId: 'new-daemon',
          bootId: 'new-boot',
        });
        if (takeover.outcome !== 'claimed') throw new Error('takeover was not claimed');
        await expect(
          actions.admitProviderCall({
            actionId: oldClaim.id,
            channelId: graph.channel.id,
            actionClaimToken: oldClaim.claim_token!,
            actionClaimGeneration: oldClaim.claim_generation,
            listenerClaimToken: oldListener.lease.claim_token,
            listenerGeneration: oldListener.lease.generation,
            leaseMs: 30_000,
          })
        ).resolves.toBeNull();
        const [reclaimed] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: takeover.lease.claim_token,
          listenerGeneration: takeover.lease.generation,
          actionClaimToken: 'before-rest-new-action',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'new-daemon', bootId: 'new-boot' },
        });
        await expect(
          actions.admitProviderCall({
            actionId: reclaimed.id,
            channelId: graph.channel.id,
            actionClaimToken: reclaimed.claim_token!,
            actionClaimGeneration: reclaimed.claim_generation,
            listenerClaimToken: takeover.lease.claim_token,
            listenerGeneration: takeover.lease.generation,
            leaseMs: 30_000,
          })
        ).resolves.toMatchObject({ id: oldClaim.id });
      });
    });

    it('revokes config-bound work and rejects its later provider completion', async () => {
      const tenantId = `provider-actions-config-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const channels = new GatewayChannelRepository(scoped);
        const actions = new GatewayProviderActionRepository(scoped);
        const queued = await actions.enqueue(enqueueInput(graph, 0));
        const listener = await channels.claimListener({
          channelId: graph.channel.id,
          claimToken: 'listener-owner',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-owner',
          bootId: 'boot-owner',
        });
        if (listener.outcome !== 'claimed') throw new Error('listener was not claimed');
        const [claim] = await actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: listener.lease.claim_token,
          listenerGeneration: listener.lease.generation,
          actionClaimToken: 'action-owner',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'daemon-owner', bootId: 'boot-owner' },
        });
        const changed = await channels.update(graph.channel.id, { enabled: false });
        expect(changed.provider_config_generation).toBe(
          queued.action.provider_config_generation + 1
        );
        expect(await actions.findById(claim.id)).toMatchObject({ status: 'canceled' });
        await expect(
          actions.complete({
            actionId: claim.id,
            channelId: graph.channel.id,
            actionClaimToken: claim.claim_token!,
            actionClaimGeneration: claim.claim_generation,
            listenerClaimToken: listener.lease.claim_token,
            listenerGeneration: listener.lease.generation,
            result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
          })
        ).resolves.toBe(false);
      });
    });

    it('authorizes new same-key work after credential rotation and re-verification', async () => {
      const tenantId = `provider-actions-reauthorize-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const channels = new GatewayChannelRepository(scoped);
        const actions = new GatewayProviderActionRepository(scoped);
        const stale = await actions.enqueue(enqueueInput(graph, 0));
        const nextToken = `discord-token-${generateId()}`;
        const rotated = await channels.update(graph.channel.id, {
          config: { bot_token: nextToken },
        });
        expect(rotated.provider_installation_id).toBeNull();
        expect(await actions.findById(stale.action.id)).toMatchObject({ status: 'canceled' });

        await channels.claimProviderInstallationIdentity({
          channelId: graph.channel.id,
          channelType: 'discord',
          providerInstallationId: graph.applicationId,
          expectedConfig: {
            application_id: graph.applicationId,
            bot_token: nextToken,
          },
        });
        const current = await actions.enqueue(enqueueInput(graph, 0));
        expect(current.outcome).toBe('enqueued');
        expect(current.action.id).not.toBe(stale.action.id);
        expect(current.action.provider_config_generation).toBeGreaterThan(
          stale.action.provider_config_generation
        );
        expect(await actions.findById(stale.action.id)).toMatchObject({ status: 'canceled' });
      });
    });

    it('counts strict active Discord progress with PostgreSQL JSON and tenant RLS', async () => {
      const tenantId = `provider-actions-presence-${generateId()}` as TenantID;
      const otherTenantId = `provider-actions-presence-other-${generateId()}` as TenantID;
      const graph = await seedActionGraph(db, tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const mappings = new ThreadSessionMapRepository(scoped);
        await mappings.updateMetadataAtomic(graph.mapping.id, (metadata) => ({
          ...metadata,
          discord_progress_task_id: graph.task.task_id,
          discord_progress_revision: 1,
          discord_progress_state: 'working',
        }));
        await expect(mappings.countActiveDiscordProgress(graph.channel.id)).resolves.toBe(1);
      });
      await runWithTenantDatabaseScope(db, otherTenantId, async (scoped) => {
        await expect(
          new ThreadSessionMapRepository(scoped).countActiveDiscordProgress(graph.channel.id)
        ).resolves.toBe(0);
      });
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const mappings = new ThreadSessionMapRepository(scoped);
        await mappings.updateMetadataAtomic(graph.mapping.id, (metadata) => ({
          ...metadata,
          discord_progress_state: 'done',
          discord_progress_revision: 2,
        }));
        await expect(mappings.countActiveDiscordProgress(graph.channel.id)).resolves.toBe(0);
      });
    });
  }
);
