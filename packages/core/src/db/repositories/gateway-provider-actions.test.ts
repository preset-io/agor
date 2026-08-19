import {
  type MessageID,
  MessageRole,
  type SessionID,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDiscordDeliveryPlan } from '../../gateway/connectors/discord-delivery';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { update } from '../database-wrapper';
import { gatewayChannels, gatewayProviderActions } from '../schema';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { GatewayInboundEventRepository } from './gateway-inbound-events';
import {
  GATEWAY_PROVIDER_ACTION_DISCORD_NOTICE_TTL_MS,
  GatewayProviderActionBacklogError,
  GatewayProviderActionRepository,
  parseGatewayProviderActionParams,
  parseGatewayProviderActionResult,
} from './gateway-provider-actions';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { ThreadSessionMapRepository } from './thread-session-map';
import { UsersRepository } from './users';

const APPLICATION_ID = '123456789012345678';
const BOT_TOKEN = 'discord-test-token';
let installationOffset = 0n;

async function seedActionGraph(
  db: Database,
  taskStatus: (typeof TaskStatus)[keyof typeof TaskStatus] = TaskStatus.COMPLETED
) {
  const applicationId = String(BigInt(APPLICATION_ID) + installationOffset++);
  const owner = await new UsersRepository(db).create({
    email: `${generateId()}@example.invalid`,
    name: 'Provider action owner',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `provider-actions/${generateId()}`,
    name: 'provider-actions',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/provider-actions.git',
    local_path: `/tmp/provider-actions-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Number(BigInt(`0x${generateId().replaceAll('-', '').slice(0, 8)}`)),
    path: `/tmp/provider-actions-${generateId()}`,
    created_by: owner.user_id,
  });
  const channels = new GatewayChannelRepository(db);
  const channel = await channels.create({
    id: generateId(),
    name: 'Discord provider actions',
    channel_type: 'discord',
    created_by: owner.user_id,
    agor_user_id: owner.user_id,
    target_branch_id: branch.branch_id,
    channel_key: generateId(),
    enabled: false,
    config: {
      bot_token: BOT_TOKEN,
      application_id: applicationId,
      guild_id: '223456789012345678',
      allowed_channel_ids: ['323456789012345678'],
    },
  });
  expect(channel.provider_config_generation).toBe(1);
  await expect(
    channels.claimProviderInstallationIdentity({
      channelId: channel.id,
      channelType: 'discord',
      providerInstallationId: applicationId,
      expectedConfig: { application_id: applicationId, bot_token: BOT_TOKEN },
    })
  ).resolves.toBe(true);
  const verified = await channels.findById(channel.id);
  expect(verified?.provider_installation_id).toBe(applicationId);
  expect(verified?.provider_config_generation).toBe(2);

  // These repository tests exercise SQLite schema parity for the durable
  // action state machine. Product writes cannot enable Discord on SQLite, so
  // materialize the PostgreSQL-only precondition directly in this fixture
  // without weakening the launch guard in GatewayChannelRepository.
  await update(db, gatewayChannels)
    .set({ enabled: true })
    .where(eq(gatewayChannels.id, channel.id))
    .run();

  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    created_by: owner.user_id,
  });
  const task = await new TaskRepository(db).create({
    task_id: generateId(),
    session_id: session.session_id,
    status: taskStatus,
    full_prompt: 'provider action test',
    message_range: {
      start_index: 0,
      end_index: 1,
      start_timestamp: new Date().toISOString(),
    },
    created_by: owner.user_id,
  });
  const message = await new MessagesRepository(db).create({
    message_id: generateId() as MessageID,
    session_id: session.session_id as SessionID,
    task_id: task.task_id as TaskID,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp: new Date().toISOString(),
    content_preview: 'canonical final',
    content: 'canonical final body',
  });
  const mapping = await new ThreadSessionMapRepository(db).create({
    id: generateId(),
    channel_id: channel.id,
    thread_id: 'discord:423456789012345678',
    session_id: session.session_id,
    branch_id: branch.branch_id,
    status: 'active',
  });
  return { applicationId, channels, channel: verified!, mapping, session, task, message, owner };
}

async function setSqliteParityDiscordEnabled(
  db: Database,
  channelId: string,
  enabled: boolean
): Promise<void> {
  await update(db, gatewayChannels).set({ enabled }).where(eq(gatewayChannels.id, channelId)).run();
}

function enqueueInput(graph: Awaited<ReturnType<typeof seedActionGraph>>, suffix = 'final') {
  return {
    kind: 'deliver_message' as const,
    channelId: graph.channel.id,
    idempotencyKey: `message:${graph.message.message_id}:${suffix}`,
    mappingId: graph.mapping.id,
    sessionId: graph.session.session_id,
    taskId: graph.task.task_id,
    messageId: graph.message.message_id,
    params: { operation: 'create' as const },
  };
}

async function claimListener(
  channels: GatewayChannelRepository,
  channelId: Awaited<ReturnType<typeof seedActionGraph>>['channel']['id'],
  token: string,
  leaseDurationMs = 30_000
) {
  const result = await channels.claimListener({
    channelId,
    claimToken: token,
    leaseDurationMs,
    instanceId: `instance-${token}`,
    bootId: `boot-${token}`,
  });
  if (result.outcome !== 'claimed') throw new Error(`listener was not claimed: ${result.outcome}`);
  return result.lease;
}

describe('GatewayProviderActionRepository', () => {
  it('strictly validates content-free Discord history action coordinates', () => {
    const requestId = generateId();
    expect(
      parseGatewayProviderActionParams(
        {
          request_id: requestId,
          initial_message_id: '523456789012345678',
          through_message_id: '623456789012345678',
          after_message_id: '523456789012345678',
          limit: 200,
        },
        'discord_thread_history'
      )
    ).toMatchObject({ request_id: requestId, limit: 200 });
    expect(() =>
      parseGatewayProviderActionParams(
        {
          request_id: requestId,
          initial_message_id: '523456789012345678',
          through_message_id: '623456789012345678',
          after_message_id: '723456789012345678',
          limit: 200,
        },
        'discord_thread_history'
      )
    ).toThrow(/invalid/);
    expect(
      parseGatewayProviderActionResult(
        {
          kind: 'discord_thread_history',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000099',
          sha256: 'a'.repeat(64),
          byte_length: 128,
          message_count: 2,
          has_more: true,
          next_message_id: '623456789012345678',
        },
        'discord_thread_history'
      )
    ).toMatchObject({ message_count: 2, has_more: true });
    expect(() =>
      parseGatewayProviderActionResult(
        {
          kind: 'discord_thread_history',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000099',
          sha256: 'a'.repeat(64),
          byte_length: 128,
          message_count: 2,
          has_more: true,
          content: 'must not persist',
        },
        'discord_thread_history'
      )
    ).toThrow(/invalid/i);
  });

  dbTest('rejects Discord history runtime enqueue on SQLite parity storage', async ({ db }) => {
    const graph = await seedActionGraph(db);
    const actions = new GatewayProviderActionRepository(db);
    await expect(
      actions.enqueue({
        kind: 'discord_thread_history',
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        idempotencyKey: `discord_thread_history:${generateId()}`,
        params: {
          request_id: generateId(),
          initial_message_id: '523456789012345678',
          through_message_id: '623456789012345678',
          limit: 50,
        },
      })
    ).rejects.toThrow(/require PostgreSQL/);
  });

  dbTest(
    'persists an idempotent fixed Discord notice from only its canonical inbound event',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const other = await seedActionGraph(db);
      const inboundEvents = new GatewayInboundEventRepository(db);
      const claimed = await inboundEvents.claim({
        channelId: graph.channel.id,
        providerEventId: `discord:message:${graph.applicationId}:523456789012345678`,
        threadId: 'discord:523456789012345678',
        processingToken: 'notice-event',
        leaseDurationMs: 30_000,
        requireListenerClaim: false,
      });
      if (claimed.outcome !== 'claimed') throw new Error('expected inbound event claim');
      const otherClaim = await inboundEvents.claim({
        channelId: other.channel.id,
        providerEventId: `discord:message:${other.applicationId}:523456789012345679`,
        threadId: 'discord:523456789012345679',
        processingToken: 'other-notice-event',
        leaseDurationMs: 30_000,
        requireListenerClaim: false,
      });
      if (otherClaim.outcome !== 'claimed') throw new Error('expected other inbound event claim');

      const actions = new GatewayProviderActionRepository(db);
      const input = {
        kind: 'discord_notice' as const,
        channelId: graph.channel.id,
        inboundEventId: claimed.event.id,
        idempotencyKey: `discord_notice:${claimed.event.id}:routing`,
        params: { notice_code: 'alignment_missing' as const },
      };
      const queued = await actions.enqueue(input);
      expect(queued.action).toMatchObject({
        kind: 'discord_notice',
        thread_session_map_id: null,
        session_id: null,
        task_id: null,
        message_id: null,
        gateway_inbound_event_id: claimed.event.id,
        params: { notice_code: 'alignment_missing' },
      });
      expect(Date.parse(queued.action.drop_after!) - Date.parse(queued.action.created_at)).toBe(
        GATEWAY_PROVIDER_ACTION_DISCORD_NOTICE_TTL_MS
      );
      await expect(actions.enqueue(input)).resolves.toMatchObject({ outcome: 'duplicate' });
      await expect(
        actions.enqueue({ ...input, params: { notice_code: 'alignment_inactive' as const } })
      ).rejects.toThrow(/reused for different work/);
      await expect(
        actions.enqueue({ ...input, inboundEventId: otherClaim.event.id })
      ).rejects.toThrow(/canonical references do not match/);
      await expect(
        actions.enqueue({
          ...input,
          idempotencyKey: `${input.idempotencyKey}:bad`,
          params: { notice_code: 'arbitrary_text' as never },
        })
      ).rejects.toThrow(/notice code/);

      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-notice');
      const [action] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'action-notice',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-notice', bootId: 'boot-notice' },
      });
      const plan = createDiscordDeliveryPlan(
        'fixed notice',
        claimed.event.id,
        'discord_notice:alignment_missing'
      );
      const exactClaim = {
        actionId: action.id,
        channelId: graph.channel.id,
        actionClaimToken: action.claim_token!,
        actionClaimGeneration: action.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
      };
      await expect(
        actions.initializeDiscordDelivery({ ...exactClaim, metadata: plan.metadata })
      ).resolves.toMatchObject({ outcome: 'initialized' });
      await expect(
        actions.recordDiscordDeliveryChunk({
          ...exactClaim,
          expectedMetadata: plan.metadata,
          chunkIndex: 0,
          providerMessageId: '623456789012345678',
        })
      ).resolves.toMatchObject({ outcome: 'recorded' });
      await expect(
        actions.complete({
          ...exactClaim,
          result: { kind: 'discord_notice', provider_message_id: '623456789012345678' },
        })
      ).resolves.toBe(true);
    }
  );

  dbTest(
    'cancels an expired Discord notice without claim or replay side effects',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const inboundEvents = new GatewayInboundEventRepository(db);
      const claimed = await inboundEvents.claim({
        channelId: graph.channel.id,
        providerEventId: `discord:message:${graph.applicationId}:523456789012345678`,
        threadId: 'discord:523456789012345678',
        processingToken: 'notice-expiry-event',
        leaseDurationMs: 30_000,
        requireListenerClaim: false,
      });
      if (claimed.outcome !== 'claimed') throw new Error('expected inbound event claim');
      const actions = new GatewayProviderActionRepository(db);
      const input = {
        kind: 'discord_notice' as const,
        channelId: graph.channel.id,
        inboundEventId: claimed.event.id,
        idempotencyKey: `discord_notice:${claimed.event.id}:routing`,
        params: { notice_code: 'alignment_missing' as const },
      };
      const queued = await actions.enqueue(input);
      await update(db, gatewayProviderActions)
        .set({ drop_after: new Date(0) })
        .where(eq(gatewayProviderActions.id, queued.action.id))
        .run();
      const lease = await claimListener(graph.channels, graph.channel.id, 'notice-expiry-owner');

      await expect(
        actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          actionClaimToken: 'notice-expiry-action',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'notice-expiry', bootId: 'notice-expiry' },
        })
      ).resolves.toEqual([]);
      await expect(actions.findById(queued.action.id)).resolves.toMatchObject({
        status: 'canceled',
        last_error_code: 'notice_expired',
        dead_lettered_at: null,
      });
      await expect(actions.enqueue(input)).resolves.toMatchObject({
        outcome: 'duplicate',
        action: { id: queued.action.id, status: 'canceled' },
      });
    }
  );

  dbTest('fences a notice that expires after claim but before REST admission', async ({ db }) => {
    const graph = await seedActionGraph(db);
    const inboundEvents = new GatewayInboundEventRepository(db);
    const claimed = await inboundEvents.claim({
      channelId: graph.channel.id,
      providerEventId: `discord:message:${graph.applicationId}:523456789012345679`,
      threadId: 'discord:523456789012345679',
      processingToken: 'notice-admission-expiry-event',
      leaseDurationMs: 30_000,
      requireListenerClaim: false,
    });
    if (claimed.outcome !== 'claimed') throw new Error('expected inbound event claim');
    const actions = new GatewayProviderActionRepository(db);
    const queued = await actions.enqueue({
      kind: 'discord_notice',
      channelId: graph.channel.id,
      inboundEventId: claimed.event.id,
      idempotencyKey: `discord_notice:${claimed.event.id}:routing`,
      params: { notice_code: 'branch_access_denied' },
    });
    const lease = await claimListener(graph.channels, graph.channel.id, 'notice-admission-owner');
    const [action] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: lease.claim_token,
      listenerGeneration: lease.generation,
      actionClaimToken: 'notice-admission-action',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'notice-admission', bootId: 'notice-admission' },
    });
    await update(db, gatewayProviderActions)
      .set({ drop_after: new Date(0) })
      .where(eq(gatewayProviderActions.id, queued.action.id))
      .run();

    await expect(
      actions.admitProviderCall({
        actionId: action.id,
        channelId: graph.channel.id,
        actionClaimToken: action.claim_token!,
        actionClaimGeneration: action.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        leaseMs: 30_000,
      })
    ).resolves.toBeNull();
    await expect(actions.findById(action.id)).resolves.toMatchObject({
      status: 'canceled',
      last_error_code: 'notice_expired',
    });
  });

  dbTest('cancels an expired claimed notice during listener takeover', async ({ db }) => {
    const graph = await seedActionGraph(db);
    const inboundEvents = new GatewayInboundEventRepository(db);
    const claimed = await inboundEvents.claim({
      channelId: graph.channel.id,
      providerEventId: `discord:message:${graph.applicationId}:523456789012345680`,
      threadId: 'discord:523456789012345680',
      processingToken: 'notice-takeover-event',
      leaseDurationMs: 30_000,
      requireListenerClaim: false,
    });
    if (claimed.outcome !== 'claimed') throw new Error('expected inbound event claim');
    const actions = new GatewayProviderActionRepository(db);
    const queued = await actions.enqueue({
      kind: 'discord_notice',
      channelId: graph.channel.id,
      inboundEventId: claimed.event.id,
      idempotencyKey: `discord_notice:${claimed.event.id}:routing`,
      params: { notice_code: 'fixed_identity_invalid' },
    });
    const firstLease = await claimListener(
      graph.channels,
      graph.channel.id,
      'notice-takeover-owner-a'
    );
    const [firstClaim] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: firstLease.claim_token,
      listenerGeneration: firstLease.generation,
      actionClaimToken: 'notice-takeover-action-a',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'notice-takeover-a', bootId: 'notice-takeover-a' },
    });
    await update(db, gatewayProviderActions)
      .set({ drop_after: new Date(0) })
      .where(eq(gatewayProviderActions.id, queued.action.id))
      .run();
    await expect(
      graph.channels.releaseListener(graph.channel.id, firstLease.claim_token)
    ).resolves.toBe(true);
    const secondLease = await claimListener(
      graph.channels,
      graph.channel.id,
      'notice-takeover-owner-b'
    );

    await expect(
      actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: secondLease.claim_token,
        listenerGeneration: secondLease.generation,
        actionClaimToken: 'notice-takeover-action-b',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'notice-takeover-b', bootId: 'notice-takeover-b' },
      })
    ).resolves.toEqual([]);
    await expect(
      actions.admitProviderCall({
        actionId: firstClaim.id,
        channelId: graph.channel.id,
        actionClaimToken: firstClaim.claim_token!,
        actionClaimGeneration: firstClaim.claim_generation,
        listenerClaimToken: firstLease.claim_token,
        listenerGeneration: firstLease.generation,
        leaseMs: 30_000,
      })
    ).resolves.toBeNull();
    await expect(actions.findById(queued.action.id)).resolves.toMatchObject({
      status: 'canceled',
      last_error_code: 'notice_expired',
      dead_lettered_at: null,
    });
  });

  dbTest(
    'keeps a partial row from another formatter release decodable and fail-closed',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      await actions.enqueue(enqueueInput(graph, 'formatter-release'));
      const lease = await claimListener(graph.channels, graph.channel.id, 'formatter-release');
      const [action] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'formatter-release-action',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'formatter-release', bootId: 'formatter-release' },
      });
      const current = createDiscordDeliveryPlan('canonical final body', graph.message.message_id);
      const storedFromAnotherRelease = {
        ...current.metadata,
        formatter_version: current.metadata.formatter_version + 1,
      };
      const exactClaim = {
        actionId: action.id,
        channelId: graph.channel.id,
        actionClaimToken: action.claim_token!,
        actionClaimGeneration: action.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
      };

      await expect(
        actions.initializeDiscordDelivery({
          ...exactClaim,
          metadata: storedFromAnotherRelease,
        })
      ).resolves.toMatchObject({ outcome: 'initialized' });
      await expect(actions.findById(action.id)).resolves.toMatchObject({
        execution_metadata: { formatter_version: storedFromAnotherRelease.formatter_version },
      });
      await expect(actions.getBacklogMetrics(graph.channel.id)).resolves.toMatchObject({
        formatterMismatchCount: 0,
      });
      await expect(
        actions.initializeDiscordDelivery({ ...exactClaim, metadata: current.metadata })
      ).resolves.toEqual({ outcome: 'formatter_mismatch' });
    }
  );

  dbTest(
    'checks the exact listener token and generation for owner-scoped access',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-exact');

      await expect(
        graph.channels.listenerClaimIsCurrent(graph.channel.id, lease.claim_token, lease.generation)
      ).resolves.toBe(true);
      await expect(
        graph.channels.listenerClaimIsCurrent(
          graph.channel.id,
          lease.claim_token,
          lease.generation + 1
        )
      ).resolves.toBe(false);
    }
  );

  dbTest(
    'deduplicates exact work and rejects key reuse, bounds, and backlog overflow',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db, { maxBacklogPerChannel: 1 });
      const first = await actions.enqueue(enqueueInput(graph));
      expect(first.outcome).toBe('enqueued');
      expect(first.action.provider_installation_id).toBe(graph.applicationId);
      expect(first.action.provider_config_generation).toBe(2);
      expect(first.action.message_id).toBe(graph.message.message_id);
      expect(first.action.params).toEqual({ operation: 'create' });

      const duplicate = await actions.enqueue(enqueueInput(graph));
      expect(duplicate).toEqual({ outcome: 'duplicate', action: first.action });
      await expect(
        actions.enqueue({
          ...enqueueInput(graph),
          params: { operation: 'edit' as const, provider_message_id: '523456789012345678' },
        })
      ).rejects.toThrow(/reused for different work/);
      await expect(actions.enqueue(enqueueInput(graph, 'second'))).rejects.toBeInstanceOf(
        GatewayProviderActionBacklogError
      );
      await expect(
        actions.enqueue({ ...enqueueInput(graph), idempotencyKey: 'x'.repeat(201) })
      ).rejects.toThrow(/at most 200 bytes/);
      await expect(
        actions.enqueue({
          ...enqueueInput(graph),
          params: { operation: 'edit' as const, provider_message_id: 'x'.repeat(129) },
        })
      ).rejects.toThrow(/at most 128 bytes/);
    }
  );

  dbTest(
    'requires canonical references to match the visible channel/session graph',
    async ({ db }) => {
      const left = await seedActionGraph(db);
      const right = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      await expect(
        actions.enqueue({ ...enqueueInput(left), messageId: right.message.message_id })
      ).rejects.toThrow(/canonical references do not match/);
      await expect(
        actions.enqueue({ ...enqueueInput(left), channelId: 'not-a-uuid' as never })
      ).rejects.toThrow(/canonical UUID/);
    }
  );

  dbTest(
    're-enqueues the same canonical delivery after credential re-verification without reviving stale work',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      const first = await actions.enqueue(enqueueInput(graph));

      const rotatedToken = `rotated-${generateId()}`;
      await setSqliteParityDiscordEnabled(db, graph.channel.id, false);
      const rotated = await graph.channels.update(graph.channel.id, {
        config: { bot_token: rotatedToken },
      });
      expect(rotated.provider_installation_id).toBeNull();
      expect(await actions.findById(first.action.id)).toMatchObject({
        status: 'canceled',
        provider_config_generation: rotated.provider_config_generation - 1,
      });
      await expect(
        graph.channels.claimProviderInstallationIdentity({
          channelId: graph.channel.id,
          channelType: 'discord',
          providerInstallationId: graph.applicationId,
          expectedConfig: {
            application_id: graph.applicationId,
            bot_token: rotatedToken,
          },
        })
      ).resolves.toBe(true);
      const reverified = await graph.channels.findById(graph.channel.id);
      expect(reverified?.provider_config_generation).toBe(rotated.provider_config_generation + 1);

      await setSqliteParityDiscordEnabled(db, graph.channel.id, true);
      const replay = await actions.enqueue(enqueueInput(graph));
      expect(replay.outcome).toBe('enqueued');
      expect(replay.action).toMatchObject({
        status: 'pending',
        idempotency_key: first.action.idempotency_key,
        provider_config_generation: reverified!.provider_config_generation,
      });
      expect(replay.action.id).not.toBe(first.action.id);
      expect(await actions.findById(first.action.id)).toMatchObject({ status: 'canceled' });
    }
  );

  dbTest(
    'claims only for the current listener and fences provider-call admission and completion',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      const queued = await actions.enqueue(enqueueInput(graph));
      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-a');

      await expect(
        actions.claimForListener({
          channelId: graph.channel.id,
          listenerClaimToken: 'stale-listener',
          listenerGeneration: lease.generation,
          actionClaimToken: 'action-a',
          leaseMs: 30_000,
          limit: 1,
          identity: { instanceId: 'instance-a', bootId: 'boot-a' },
        })
      ).resolves.toEqual([]);

      const [claim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'action-a',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });
      expect(claim).toMatchObject({
        id: queued.action.id,
        status: 'processing',
        attempts: 1,
        claim_generation: 1,
        claim_listener_generation: lease.generation,
      });
      await expect(
        actions.admitProviderCall({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: 'stale-action',
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          leaseMs: 30_000,
        })
      ).resolves.toBeNull();
      await expect(
        actions.admitProviderCall({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          leaseMs: 30_000,
        })
      ).resolves.toMatchObject({ id: claim.id, status: 'processing' });
      await expect(
        actions.complete({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation + 1,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
        })
      ).resolves.toBe(false);
      const delivery = createDiscordDeliveryPlan('canonical final body', graph.message.message_id);
      const exactClaim = {
        actionId: claim.id,
        channelId: graph.channel.id,
        actionClaimToken: claim.claim_token!,
        actionClaimGeneration: claim.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
      };
      await expect(
        actions.initializeDiscordDelivery({ ...exactClaim, metadata: delivery.metadata })
      ).resolves.toMatchObject({ outcome: 'initialized' });
      await expect(
        actions.recordDiscordDeliveryChunk({
          ...exactClaim,
          expectedMetadata: delivery.metadata,
          chunkIndex: 0,
          providerMessageId: '523456789012345678',
        })
      ).resolves.toMatchObject({ outcome: 'recorded' });
      await expect(
        actions.complete({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
        })
      ).resolves.toBe(true);
      expect(await actions.findById(claim.id)).toMatchObject({
        status: 'completed',
        result_metadata: {
          kind: 'deliver_message',
          provider_message_id: '523456789012345678',
        },
        claim_token: null,
      });
    }
  );

  dbTest(
    'freezes and checkpoints every chunk, exposes partial health, and repairs without reposting',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      const queued = await actions.enqueue(enqueueInput(graph, 'multi'));
      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-multi');
      const [claim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'action-multi',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-multi', bootId: 'boot-multi' },
      });
      expect(claim.id).toBe(queued.action.id);
      const plan = createDiscordDeliveryPlan(
        `${'a'.repeat(2_000)}\n\n${'b'.repeat(2_000)}\n\nend`,
        graph.message.message_id
      );
      expect(plan.chunks.length).toBeGreaterThan(1);
      const exactClaim = {
        actionId: claim.id,
        channelId: graph.channel.id,
        actionClaimToken: claim.claim_token!,
        actionClaimGeneration: claim.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
      };
      await expect(
        actions.initializeDiscordDelivery({ ...exactClaim, metadata: plan.metadata })
      ).resolves.toMatchObject({ outcome: 'initialized' });
      const changedIdentity = createDiscordDeliveryPlan(
        plan.chunks.map((chunk) => chunk.content).join('\nchanged\n'),
        graph.message.message_id,
        'changed canonical source'
      );
      await expect(
        actions.initializeDiscordDelivery({ ...exactClaim, metadata: changedIdentity.metadata })
      ).resolves.toEqual({ outcome: 'formatter_mismatch' });
      await expect(
        actions.recordDiscordDeliveryChunk({
          ...exactClaim,
          expectedMetadata: plan.metadata,
          chunkIndex: 1,
          providerMessageId: '523456789012345679',
        })
      ).resolves.toEqual({ outcome: 'out_of_order' });
      await expect(
        actions.recordDiscordDeliveryChunk({
          ...exactClaim,
          expectedMetadata: plan.metadata,
          chunkIndex: 0,
          providerMessageId: '523456789012345678',
        })
      ).resolves.toMatchObject({ outcome: 'recorded' });
      await expect(
        actions.complete({
          ...exactClaim,
          result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
        })
      ).rejects.toThrow(/every durable chunk/);
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        partialDeliveryCount: 1,
      });
      await expect(
        actions.deadLetter({ ...exactClaim, errorCode: 'discord_nonce_recovery_incomplete' })
      ).resolves.toBe(true);
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        partialDeliveryCount: 1,
        nonceRecoveryIncompleteCount: 1,
      });
      const providerMessageIds = plan.chunks.map((_, index) =>
        String(623456789012345678n + BigInt(index))
      );
      providerMessageIds[0] = '523456789012345678';
      await expect(
        actions.repairDiscordDeliveryCoordinates({
          actionId: claim.id,
          channelId: graph.channel.id,
          operatorUserId: graph.owner.user_id,
          expectedMetadata: plan.metadata,
          providerMessageIds,
        })
      ).resolves.toBe(true);
      expect(await actions.findById(claim.id)).toMatchObject({
        status: 'completed',
        execution_metadata: {
          kind: 'discord_delivery',
          repair: {
            outcome: 'coordinates_recorded',
            operator_user_id: graph.owner.user_id,
          },
        },
        result_metadata: {
          kind: 'deliver_message',
          provider_message_id: providerMessageIds.at(-1),
        },
      });
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        partialDeliveryCount: 0,
        nonceRecoveryIncompleteCount: 0,
      });
    }
  );

  dbTest(
    'audits explicit delivery abandonment without inventing a provider coordinate',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      await actions.enqueue(enqueueInput(graph, 'abandon'));
      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-abandon');
      const [claim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'action-abandon',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-abandon', bootId: 'boot-abandon' },
      });
      const plan = createDiscordDeliveryPlan('canonical final body', graph.message.message_id);
      const exactClaim = {
        actionId: claim.id,
        channelId: graph.channel.id,
        actionClaimToken: claim.claim_token!,
        actionClaimGeneration: claim.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
      };
      await actions.initializeDiscordDelivery({ ...exactClaim, metadata: plan.metadata });
      await actions.deadLetter({ ...exactClaim, errorCode: 'discord_formatter_mismatch' });
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        formatterMismatchCount: 1,
      });
      await expect(
        actions.abandonDiscordDelivery({
          actionId: claim.id,
          channelId: graph.channel.id,
          operatorUserId: graph.owner.user_id,
          expectedMetadata: plan.metadata,
        })
      ).resolves.toBe(true);
      expect(await actions.findById(claim.id)).toMatchObject({
        status: 'canceled',
        last_error_code: 'operator_abandoned_delivery',
        result_metadata: null,
        execution_metadata: {
          repair: {
            outcome: 'abandoned',
            operator_user_id: graph.owner.user_id,
          },
        },
      });
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        formatterMismatchCount: 0,
      });
    }
  );

  dbTest('survives listener takeover and reclaims only an expired action claim', async ({ db }) => {
    const graph = await seedActionGraph(db);
    const actions = new GatewayProviderActionRepository(db);
    await actions.enqueue(enqueueInput(graph));
    const firstLease = await claimListener(graph.channels, graph.channel.id, 'listener-a');
    const [firstClaim] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: firstLease.claim_token,
      listenerGeneration: firstLease.generation,
      actionClaimToken: 'action-a',
      leaseMs: 2,
      limit: 1,
      identity: { instanceId: 'instance-a', bootId: 'boot-a' },
    });
    await graph.channels.releaseListener(graph.channel.id, firstLease.claim_token);
    await new Promise((resolve) => setTimeout(resolve, 8));
    const secondLease = await claimListener(graph.channels, graph.channel.id, 'listener-b');
    const [reclaimed] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: secondLease.claim_token,
      listenerGeneration: secondLease.generation,
      actionClaimToken: 'action-b',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'instance-b', bootId: 'boot-b' },
    });
    expect(reclaimed).toMatchObject({
      id: firstClaim.id,
      attempts: 2,
      claim_generation: firstClaim.claim_generation + 1,
      claim_token: 'action-b',
      claim_listener_generation: secondLease.generation,
    });
    await expect(
      actions.complete({
        actionId: firstClaim.id,
        channelId: graph.channel.id,
        actionClaimToken: 'action-a',
        actionClaimGeneration: firstClaim.claim_generation,
        listenerClaimToken: firstLease.claim_token,
        listenerGeneration: firstLease.generation,
        result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
      })
    ).resolves.toBe(false);
    await expect(
      actions.retry({
        actionId: firstClaim.id,
        channelId: graph.channel.id,
        actionClaimToken: 'action-a',
        actionClaimGeneration: firstClaim.claim_generation,
        listenerClaimToken: firstLease.claim_token,
        listenerGeneration: firstLease.generation,
        errorCode: 'transport_failed',
        retryAfterMs: 1_000,
      })
    ).resolves.toBe(false);
  });

  dbTest(
    'config mutation increments its own revision, revokes the owner, and cancels stale work',
    async ({ db }) => {
      const graph = await seedActionGraph(db);
      const actions = new GatewayProviderActionRepository(db);
      const queued = await actions.enqueue(enqueueInput(graph));
      const lease = await claimListener(graph.channels, graph.channel.id, 'listener-a');
      const [claim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'action-a',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });

      await setSqliteParityDiscordEnabled(db, graph.channel.id, false);
      const renamed = await graph.channels.update(graph.channel.id, { name: 'Renamed only' });
      expect(renamed.provider_config_generation).toBe(2);
      const reconfigured = await graph.channels.update(graph.channel.id, {
        config: { allowed_channel_ids: ['323456789012345678', '623456789012345678'] },
      });
      expect(reconfigured.provider_config_generation).toBe(3);
      expect(reconfigured.provider_installation_id).toBe(graph.applicationId);
      expect(await actions.findById(queued.action.id)).toMatchObject({
        status: 'canceled',
        last_error_code: 'provider_configuration_changed',
        claim_token: null,
      });
      await expect(
        actions.complete({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          result: { kind: 'deliver_message', provider_message_id: '523456789012345678' },
        })
      ).resolves.toBe(false);
    }
  );

  dbTest('records bounded retry/dead-letter classifications without raw errors', async ({ db }) => {
    const graph = await seedActionGraph(db);
    const actions = new GatewayProviderActionRepository(db);
    await actions.enqueue(enqueueInput(graph));
    const lease = await claimListener(graph.channels, graph.channel.id, 'listener-a');
    const [claim] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: lease.claim_token,
      listenerGeneration: lease.generation,
      actionClaimToken: 'action-a',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'instance-a', bootId: 'boot-a' },
    });
    await expect(
      actions.retry({
        actionId: claim.id,
        channelId: graph.channel.id,
        actionClaimToken: claim.claim_token!,
        actionClaimGeneration: claim.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        errorCode: 'rate_limited',
        retryAfterMs: 25,
      })
    ).resolves.toBe(true);
    expect(await actions.findById(claim.id)).toMatchObject({
      status: 'retry',
      last_error_code: 'rate_limited',
    });
    await expect(
      actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'too-early-action',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      })
    ).resolves.toEqual([]);
    await expect(
      actions.deadLetter({
        actionId: claim.id,
        channelId: graph.channel.id,
        actionClaimToken: claim.claim_token!,
        actionClaimGeneration: claim.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        errorCode: 'raw provider error!',
      })
    ).rejects.toThrow(/sanitized/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [retried] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: lease.claim_token,
      listenerGeneration: lease.generation,
      actionClaimToken: 'action-b',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'instance-a', bootId: 'boot-a' },
    });
    expect(retried).toMatchObject({ attempts: 2, claim_generation: 2 });
    await expect(
      actions.deadLetter({
        actionId: retried.id,
        channelId: graph.channel.id,
        actionClaimToken: retried.claim_token!,
        actionClaimGeneration: retried.claim_generation,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        errorCode: 'permission_denied',
      })
    ).resolves.toBe(true);
    expect(await actions.findById(retried.id)).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'permission_denied',
    });
  });

  dbTest(
    'atomically coalesces monotonic Discord progress and fences stale handle writes',
    async ({ db }) => {
      const graph = await seedActionGraph(db, TaskStatus.RUNNING);
      const actions = new GatewayProviderActionRepository(db);
      const mappings = new ThreadSessionMapRepository(db);
      const first = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'working',
        toolName: '/secret/path',
        dropAfterMs: 60_000,
      });
      expect(first.outcome).toBe('enqueued');
      if (first.outcome === 'ignored') throw new Error('progress was unexpectedly ignored');
      expect(first.action).toMatchObject({
        kind: 'discord_progress',
        message_id: null,
        params: { state: 'working', revision: 1 },
        status: 'pending',
      });
      expect(first.action.params).not.toHaveProperty('tool_name');
      expect(first.action.drop_after).not.toBeNull();

      const lease = await claimListener(graph.channels, graph.channel.id, 'progress-listener');
      const [staleClaim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'progress-stale',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });
      const latest = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'working',
        toolName: 'Grep',
        dropAfterMs: 60_000,
      });
      expect(latest.outcome).toBe('coalesced');
      if (latest.outcome === 'ignored') throw new Error('progress was unexpectedly ignored');
      expect(latest.action).toMatchObject({
        id: first.action.id,
        status: 'pending',
        claim_token: null,
        params: { state: 'working', revision: 2, tool_name: 'Grep' },
      });
      await expect(
        actions.complete({
          actionId: staleClaim.id,
          channelId: graph.channel.id,
          actionClaimToken: staleClaim.claim_token!,
          actionClaimGeneration: staleClaim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          result: {
            kind: 'discord_progress',
            outcome: 'upserted',
            provider_message_id: '523456789012345678',
          },
        })
      ).resolves.toBe(false);

      const [claim] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'progress-current',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });
      await expect(
        actions.armDiscordProgressCreate({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          expectedTaskId: graph.task.task_id,
          expectedRevision: 2,
        })
      ).resolves.toBe('updated');
      await expect(
        actions.updateDiscordProgressHandle({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          expectedTaskId: graph.task.task_id,
          expectedRevision: 1,
          expectedProviderMessageId: null,
          providerMessageId: '523456789012345678',
        })
      ).resolves.toBe('superseded');
      await expect(
        actions.updateDiscordProgressHandle({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          expectedTaskId: graph.task.task_id,
          expectedRevision: 2,
          expectedProviderMessageId: null,
          providerMessageId: '523456789012345678',
        })
      ).resolves.toBe('updated');
      expect((await mappings.findById(graph.mapping.id))?.metadata).toMatchObject({
        discord_progress_task_id: graph.task.task_id,
        discord_progress_revision: 2,
        discord_progress_state: 'working',
        discord_progress_tool_name: 'Grep',
        discord_progress_message_id: '523456789012345678',
      });
      expect((await mappings.findById(graph.mapping.id))?.metadata).not.toHaveProperty(
        'discord_progress_cleanup_debt'
      );
      await expect(
        actions.complete({
          actionId: claim.id,
          channelId: graph.channel.id,
          actionClaimToken: claim.claim_token!,
          actionClaimGeneration: claim.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          result: {
            kind: 'deliver_message',
            provider_message_id: '523456789012345678',
          },
        })
      ).rejects.toThrow(/result kind/);

      const done = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'done',
        dropAfterMs: 60_000,
      });
      expect(done.outcome).toBe('coalesced');
      if (done.outcome === 'ignored') throw new Error('terminal cleanup was unexpectedly ignored');
      expect(done.action.drop_after).toBeNull();
      expect((await mappings.findById(graph.mapping.id))?.metadata).toMatchObject({
        discord_progress_task_id: graph.task.task_id,
        discord_progress_state: 'done',
        discord_progress_cleanup_debt: [
          {
            task_id: graph.task.task_id,
            provider_message_id: '523456789012345678',
          },
        ],
      });
      const late = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'working',
        toolName: 'Read',
        dropAfterMs: 60_000,
      });
      expect(late).toEqual({ outcome: 'ignored', reason: 'terminal_regression' });
      expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
        activeCount: 1,
        deadLetterCount: 0,
      });
    }
  );

  dbTest('converts expired Discord display work into non-expiring cleanup', async ({ db }) => {
    const graph = await seedActionGraph(db, TaskStatus.RUNNING);
    const actions = new GatewayProviderActionRepository(db);
    const mappings = new ThreadSessionMapRepository(db);
    const progress = await actions.enqueueDiscordProgress({
      channelId: graph.channel.id,
      mappingId: graph.mapping.id,
      sessionId: graph.session.session_id,
      taskId: graph.task.task_id,
      state: 'queued',
      dropAfterMs: 1,
    });
    if (progress.outcome === 'ignored') throw new Error('progress was unexpectedly ignored');
    const lease = await claimListener(graph.channels, graph.channel.id, 'expiry-listener');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [cleanup] = await actions.claimForListener({
      channelId: graph.channel.id,
      listenerClaimToken: lease.claim_token,
      listenerGeneration: lease.generation,
      actionClaimToken: 'expired-action',
      leaseMs: 30_000,
      limit: 1,
      identity: { instanceId: 'instance-a', bootId: 'boot-a' },
    });
    expect(cleanup).toMatchObject({
      id: progress.action.id,
      status: 'processing',
      params: {
        state: 'done',
        revision: 2,
        cleanup_reason: 'activity_expired',
      },
      drop_after: null,
      last_error_code: 'activity_expired',
    });
    expect((await mappings.findById(graph.mapping.id))?.metadata).toMatchObject({
      discord_progress_task_id: graph.task.task_id,
      discord_progress_revision: 2,
      discord_progress_state: 'done',
      discord_progress_cleanup_debt: [{ task_id: graph.task.task_id }],
    });
    expect(await actions.getBacklogMetrics(graph.channel.id)).toMatchObject({
      activeCount: 1,
    });
  });

  dbTest(
    'preserves stale create cleanup debt across same-task terminal coalescing',
    async ({ db }) => {
      const graph = await seedActionGraph(db, TaskStatus.RUNNING);
      const actions = new GatewayProviderActionRepository(db);
      const mappings = new ThreadSessionMapRepository(db);
      const working = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'working',
        dropAfterMs: 60_000,
      });
      if (working.outcome === 'ignored') throw new Error('progress was unexpectedly ignored');
      const lease = await claimListener(graph.channels, graph.channel.id, 'cleanup-race');
      const [stale] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'stale-create',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });
      await expect(
        actions.armDiscordProgressCreate({
          actionId: stale.id,
          channelId: graph.channel.id,
          actionClaimToken: stale.claim_token!,
          actionClaimGeneration: stale.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          expectedTaskId: graph.task.task_id,
          expectedRevision: 1,
        })
      ).resolves.toBe('updated');

      const done = await actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'done',
        dropAfterMs: 60_000,
      });
      if (done.outcome === 'ignored') throw new Error('terminal cleanup was unexpectedly ignored');
      await expect(
        actions.updateDiscordProgressHandle({
          actionId: stale.id,
          channelId: graph.channel.id,
          actionClaimToken: stale.claim_token!,
          actionClaimGeneration: stale.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          expectedTaskId: graph.task.task_id,
          expectedRevision: 1,
          expectedProviderMessageId: null,
          providerMessageId: '623456789012345678',
        })
      ).resolves.toBe('fenced');
      await expect(
        actions.recordDiscordProgressCleanupDebt({
          channelId: graph.channel.id,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          taskId: graph.task.task_id,
          providerMessageId: '623456789012345678',
        })
      ).resolves.toBe('updated');
      const terminalMetadata = (await mappings.findById(graph.mapping.id))?.metadata;
      expect(terminalMetadata).toMatchObject({
        discord_progress_state: 'done',
        discord_progress_cleanup_debt: [
          {
            task_id: graph.task.task_id,
            provider_message_id: '623456789012345678',
          },
        ],
      });
      expect(terminalMetadata).not.toHaveProperty('discord_progress_message_id');

      const [cleanup] = await actions.claimForListener({
        channelId: graph.channel.id,
        listenerClaimToken: lease.claim_token,
        listenerGeneration: lease.generation,
        actionClaimToken: 'current-cleanup',
        leaseMs: 30_000,
        limit: 1,
        identity: { instanceId: 'instance-a', bootId: 'boot-a' },
      });
      await expect(
        actions.settleDiscordProgressCleanupDebt({
          actionId: cleanup.id,
          channelId: graph.channel.id,
          actionClaimToken: cleanup.claim_token!,
          actionClaimGeneration: cleanup.claim_generation,
          listenerClaimToken: lease.claim_token,
          listenerGeneration: lease.generation,
          mappingId: graph.mapping.id,
          debt: {
            taskId: graph.task.task_id,
            providerMessageId: '623456789012345678',
          },
        })
      ).resolves.toBe('updated');
      expect(
        (await mappings.findById(graph.mapping.id))?.metadata?.discord_progress_cleanup_debt
      ).toBeUndefined();
    }
  );

  dbTest('ignores a delayed task-A terminal event after task B owns progress', async ({ db }) => {
    const graph = await seedActionGraph(db, TaskStatus.COMPLETED);
    const actions = new GatewayProviderActionRepository(db);
    const tasks = new TaskRepository(db);
    const mappings = new ThreadSessionMapRepository(db);
    await actions.enqueueDiscordProgress({
      channelId: graph.channel.id,
      mappingId: graph.mapping.id,
      sessionId: graph.session.session_id,
      taskId: graph.task.task_id,
      state: 'done',
      dropAfterMs: 60_000,
    });
    const taskB = await tasks.create({
      task_id: generateId(),
      session_id: graph.session.session_id,
      status: TaskStatus.RUNNING,
      full_prompt: 'task B',
      message_range: {
        start_index: 2,
        end_index: 3,
        start_timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      created_by: graph.channel.created_by,
    });
    await actions.enqueueDiscordProgress({
      channelId: graph.channel.id,
      mappingId: graph.mapping.id,
      sessionId: graph.session.session_id,
      taskId: taskB.task_id,
      state: 'working',
      dropAfterMs: 60_000,
    });
    await expect(
      actions.enqueueDiscordProgress({
        channelId: graph.channel.id,
        mappingId: graph.mapping.id,
        sessionId: graph.session.session_id,
        taskId: graph.task.task_id,
        state: 'done',
        dropAfterMs: 60_000,
      })
    ).resolves.toEqual({ outcome: 'ignored', reason: 'stale_task' });
    expect((await mappings.findById(graph.mapping.id))?.metadata).toMatchObject({
      discord_progress_task_id: taskB.task_id,
      discord_progress_state: 'working',
    });
  });
});
