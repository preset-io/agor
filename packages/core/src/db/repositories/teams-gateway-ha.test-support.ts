/**
 * Shared Teams gateway repository fixtures and engine-neutral cases. The SQLite
 * and PostgreSQL suites run the same cases through a {@link TeamsHarness}.
 */

import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type {
  BranchID,
  GatewayChannel,
  Message,
  MessageID,
  SessionID,
  TaskID,
  TenantID,
  UUID,
} from '../../types';
import { MessageRole, SessionStatus, TaskStatus } from '../../types';
import type { Database } from '../client';
import { runDatabaseTransaction, select, update } from '../database-wrapper';
import { gatewayInboundEvents, tasks, teamsMessageDeliveries } from '../schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import {
  GatewayInboundEventRepository,
  TeamsInboundAuthorityChangedError,
  type TeamsVerifiedHttpAdmissionInput,
} from './gateway-inbound-events';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { TeamsConversationAddressRepository } from './teams-conversation-addresses';
import { TeamsMessageDeliveryRepository } from './teams-message-deliveries';
import { ThreadSessionMapRepository } from './thread-session-map';
import { UsersRepository } from './users';

export const TEAMS_MICROSOFT_TENANT = 'teams-tenant-id';
export const TEAMS_THREAD_ID = '19:conversation@thread.tacv2';

type Scope = <T>(work: (db: Database) => Promise<T>) => Promise<T>;

/** One engine's view of a tenant: two connections, system discovery, and a foreign tenant. */
export interface TeamsHarness {
  tenantId: string;
  a: Scope;
  /** A second replica in the same tenant; SQLite reuses the one database. */
  b: Scope;
  system: <T>(
    capability: 'teams_gateway_ingress_discovery' | 'teams_message_delivery_discovery',
    work: (db: Database) => Promise<T>
  ) => Promise<T>;
  /** Another tenant on replica B; PostgreSQL only. */
  foreign?: Scope;
}

export function sqliteTeamsHarness(db: Database): TeamsHarness {
  const scope: Scope = (work) => work(db);
  return { tenantId: 'default', a: scope, b: scope, system: (_capability, work) => work(db) };
}

export function postgresTeamsHarness(dbA: Database, dbB: Database, label: string): TeamsHarness {
  const tenantId = `teams-${label}-${generateId()}` as TenantID;
  return {
    tenantId,
    a: (work) => runWithTenantDatabaseScope(dbA, tenantId, work),
    b: (work) => runWithTenantDatabaseScope(dbB, tenantId, work),
    system: (capability, work) =>
      runWithSystemDatabaseScope(dbB, `Teams ${label} discovery`, work, { capability }),
    foreign: (work) => runWithTenantDatabaseScope(dbB, `${tenantId}-other`, work),
  };
}

/** Seed an enabled Teams channel, one mapped thread, and its session in the current scope. */
export async function seedTeamsGateway(
  db: Database,
  { appId = `teams-app-${generateId()}` }: { appId?: string } = {}
) {
  const user = await new UsersRepository(db).create({
    email: `teams-${generateId()}@example.com`,
    name: 'Teams gateway test',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `teams/${generateId()}`,
    name: 'Teams gateway test repo',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/teams-gateway.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
    created_by: user.user_id,
    status: SessionStatus.IDLE,
    title: 'Teams gateway session',
    tasks: [],
  });
  const channels = new GatewayChannelRepository(db);
  const draft = await channels.create({
    name: 'Teams gateway',
    created_by: user.user_id,
    target_branch_id: branch.branch_id as UUID,
    agor_user_id: user.user_id,
    channel_type: 'teams',
    enabled: false,
    config: {
      app_id: appId,
      app_password: 'teams-app-secret',
      microsoft_tenant_id: TEAMS_MICROSOFT_TENANT,
      outbound_enabled: true,
    },
  });
  // Stands in for the service's passing credential probe of this app ID.
  const channel = await channels.updateWithVerifiedProviderInstallation(
    draft.id,
    { enabled: true },
    appId,
    draft.provider_config_generation
  );
  const mapping = await new ThreadSessionMapRepository(db).create({
    channel_id: channel.id,
    thread_id: TEAMS_THREAD_ID,
    session_id: session.session_id,
    branch_id: branch.branch_id,
    metadata: {},
  });
  return { appId, channel, mapping, session };
}

export function assistantMessage(
  sessionId: SessionID,
  index = 0,
  overrides: Partial<Message> = {}
): Message {
  return {
    message_id: generateId() as MessageID,
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: new Date().toISOString(),
    content_preview: `Reply ${index}`,
    content: `Reply ${index}`,
    ...overrides,
  };
}

/** A messages repository whose writes enqueue Teams deliveries, as the daemon wires it. */
export function teamsDeliveryWriters(db: Database) {
  const deliveries = new TeamsMessageDeliveryRepository(db);
  const messages = new MessagesRepository(db, (tx, message) =>
    deliveries.enqueueForMessageInTransaction(tx, message).then(() => undefined)
  );
  return { deliveries, messages };
}

export function teamsAdmission(
  channel: GatewayChannel,
  providerEventId = 'teams:activity:activity-1',
  threadId = TEAMS_THREAD_ID
): TeamsVerifiedHttpAdmissionInput {
  return {
    channelId: channel.id,
    providerEventId,
    threadId,
    payload: { providerEventId, threadId, text: 'hello' },
    deliveryMetadata: {
      teams_tenant_id: TEAMS_MICROSOFT_TENANT,
      teams_conversation_id: '19:secret@thread.tacv2',
      teams_channel_name: 'safe-display-name',
    },
    address: {
      conversationId: TEAMS_THREAD_ID,
      rootMessageId: null,
      address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
    },
    providerConfigGeneration: channel.provider_config_generation,
    verifiedAppId: String(channel.config.app_id),
    verifiedTenantId: TEAMS_MICROSOFT_TENANT,
  };
}

/** Seed, enqueue one reply, and claim its delivery. */
export async function seedClaimedTeamsDelivery(db: Database) {
  const fixture = await seedTeamsGateway(db);
  const { deliveries, messages } = teamsDeliveryWriters(db);
  const message = await messages.create(assistantMessage(fixture.session.session_id));
  const delivery = await deliveries.findByMessageId(message.message_id);
  if (!delivery) throw new Error('missing Teams delivery');
  const claim = await deliveries.claim(delivery.delivery_id, 'worker-a', 30_000);
  if (!claim) throw new Error('missing Teams delivery claim');
  return { ...fixture, deliveries, claim };
}

type TeamsCase = [name: string, run: (h: TeamsHarness) => Promise<void>];

/** Policy edits that bump the provider generation without changing the verified app. */
const POLICY_EDITS = {
  policy: { allowed_user_aad_object_ids: ['different-user'] },
  outbound: { outbound_enabled: false },
  'config-change': { allowed_team_ids: ['another-team'] },
} as const;

function editChannel(db: Database, channel: GatewayChannel, edit: Record<string, unknown>) {
  return new GatewayChannelRepository(db).updateWithVerifiedProviderInstallation(
    channel.id,
    { config: { ...channel.config, ...edit } },
    String(channel.config.app_id),
    channel.provider_config_generation
  );
}

const admissionFenceCases: TeamsCase[] = (['disable', 'policy', 'reclaim'] as const).map(
  (mutation) => [
    `fences Task admission after another replica commits ${mutation}`,
    async (h) => {
      const { channel, session } = await h.a(seedTeamsGateway);
      const claim = await h.a(async (db) => {
        const inbound = new GatewayInboundEventRepository(db);
        const admitted = await inbound.admitVerifiedHttp(teamsAdmission(channel));
        return inbound.claimQueued(admitted.event.id, 'worker-a', 30_000);
      });
      if (!claim) throw new Error('missing claim');
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      // The pause stands for identity and prompt preparation before the admission transaction.
      const work = (async () => {
        await paused;
        return h.a((db) =>
          runDatabaseTransaction(
            db,
            async (tx) => {
              await new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(claim);
              return new TaskRepository(tx).createPending({
                status: TaskStatus.QUEUED,
                session_id: session.session_id,
                full_prompt: 'must not be admitted',
                created_by: session.created_by!,
              });
            },
            { sqliteImmediate: true }
          )
        );
      })();
      await h.b(async (db) => {
        if (mutation === 'reclaim') {
          await update(db, gatewayInboundEvents)
            .set({ processing_expires_at: new Date(0) })
            .where(eq(gatewayInboundEvents.id, claim.id))
            .run();
          expect(
            await new GatewayInboundEventRepository(db).claimQueued(claim.id, 'worker-b', 30_000)
          ).toBeTruthy();
        } else if (mutation === 'disable') {
          await new GatewayChannelRepository(db).update(channel.id, { enabled: false });
        } else {
          await editChannel(db, channel, POLICY_EDITS.policy);
        }
      });
      const rejected = expect(work).rejects.toThrow('admission authority');
      resume();
      await rejected;
      expect(
        await h.a((db) =>
          select(db).from(tasks).where(eq(tasks.session_id, session.session_id)).all()
        )
      ).toEqual([]);
    },
  ]
);

const effectFenceCases: TeamsCase[] = (
  ['disable', 'outbound', 'config-change', 'reclaim'] as const
).map((mutation) => [
  `denies the effect marker when another replica commits ${mutation} first`,
  async (h) => {
    const { channel, claim } = await h.a(seedClaimedTeamsDelivery);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let sent = false;
    // The worker has claimed the delivery and paused in pre-send preparation.
    const work = (async () => {
      await paused;
      await h.a((db) =>
        new TeamsMessageDeliveryRepository(db).markEffectStarted({
          deliveryId: claim.delivery_id,
          claimToken: claim.claim_token,
          claimGeneration: claim.claim_generation,
        })
      );
      sent = true;
    })();
    try {
      await h.b(async (db) => {
        if (mutation === 'reclaim') {
          await update(db, teamsMessageDeliveries)
            .set({ claim_expires_at: new Date(0) })
            .where(eq(teamsMessageDeliveries.delivery_id, claim.delivery_id))
            .run();
          expect(
            await new TeamsMessageDeliveryRepository(db).claim(
              claim.delivery_id,
              'worker-b',
              30_000
            )
          ).toBeTruthy();
        } else if (mutation === 'disable') {
          await new GatewayChannelRepository(db).update(channel.id, { enabled: false });
        } else {
          await editChannel(db, channel, POLICY_EDITS[mutation]);
        }
      });
    } finally {
      resume();
    }
    await expect(work).rejects.toThrow();
    expect(sent).toBe(false);
    expect(
      await h.a((db) => new TeamsMessageDeliveryRepository(db).findById(claim.delivery_id))
    ).toMatchObject({ effect_started_at: null });
  },
]);

function gatewayTaskSource(channel: GatewayChannel, threadId: string, stamp?: UUID) {
  return {
    gateway_task_source: {
      gateway_channel_id: channel.id,
      channel_type: 'teams' as const,
      thread_id: threadId,
      provider_user_id: 'teams-user',
      ...(stamp ? { thread_session_map_id: stamp } : {}),
    },
  };
}

/** Engine-neutral cases; each suite runs every one against its own harness. */
export const TEAMS_SHARED_CASES: TeamsCase[] = [
  [
    'addresses stamped and pre-stamp Tasks, not the first session mapping',
    (h) =>
      h.a(async (db) => {
        const { channel, mapping, session } = await seedTeamsGateway(db);
        const mappings = new ThreadSessionMapRepository(db);
        const second = await mappings.create({
          channel_id: channel.id,
          session_id: session.session_id,
          branch_id: mapping.branch_id,
          thread_id: 'a:personal-conversation-id',
        });
        const taskRepo = new TaskRepository(db);
        const { deliveries, messages } = teamsDeliveryWriters(db);
        const taskFor = (stamp: UUID | undefined, prompt: string) =>
          taskRepo.create({
            task_id: generateId() as TaskID,
            session_id: session.session_id,
            created_by: session.created_by,
            full_prompt: prompt,
            status: TaskStatus.COMPLETED,
            metadata: gatewayTaskSource(channel, second.thread_id, stamp),
          });
        for (const [index, stamp] of [second.id, undefined].entries()) {
          const task = await taskFor(stamp, 'second thread');
          const message = await messages.create({
            ...assistantMessage(session.session_id, index),
            task_id: task.task_id,
          });
          expect(await deliveries.findByMessageId(message.message_id)).toMatchObject({
            thread_session_map_id: second.id,
          });
        }
        await mappings.delete(second.id);
        const task = await taskFor(second.id, 'deleted thread');
        const message = await messages.create({
          ...assistantMessage(session.session_id, 2),
          task_id: task.task_id,
        });
        expect(await deliveries.findByMessageId(message.message_id)).toBeNull();
      }),
  ],
  [
    'enqueues nothing for a Slack-sourced Task on a session with a Teams mapping',
    (h) =>
      h.a(async (db) => {
        const { session } = await seedTeamsGateway(db);
        const { deliveries, messages } = teamsDeliveryWriters(db);
        const task = await new TaskRepository(db).create({
          task_id: generateId() as TaskID,
          session_id: session.session_id,
          created_by: session.created_by,
          full_prompt: 'asked from Slack',
          status: TaskStatus.COMPLETED,
          metadata: {
            gateway_task_source: {
              gateway_channel_id: generateId(),
              channel_type: 'slack',
              thread_id: 'C123-100.000000',
              provider_user_id: 'U123',
            },
          },
        });
        const message = await messages.create({
          ...assistantMessage(session.session_id),
          task_id: task.task_id,
        });
        expect(await deliveries.findByMessageId(message.message_id)).toBeNull();
      }),
  ],
  [
    'does not adopt another session’s Task or stamped mapping',
    (h) =>
      h.a(async (db) => {
        const own = await seedTeamsGateway(db);
        const otherSession = await new SessionRepository(db).create({
          ...own.session,
          session_id: generateId() as SessionID,
        });
        const otherMapping = await new ThreadSessionMapRepository(db).create({
          channel_id: own.channel.id,
          session_id: otherSession.session_id,
          branch_id: own.mapping.branch_id,
          thread_id: 'a:other-conversation-id',
        });
        const { deliveries, messages } = teamsDeliveryWriters(db);
        const task = await new TaskRepository(db).create({
          task_id: generateId() as TaskID,
          session_id: own.session.session_id,
          created_by: own.session.created_by,
          full_prompt: 'mismatched stamp',
          status: TaskStatus.COMPLETED,
          metadata: gatewayTaskSource(own.channel, otherMapping.thread_id, otherMapping.id),
        });
        const message = await messages.create({
          ...assistantMessage(own.session.session_id, 0),
          task_id: task.task_id,
        });
        expect(await deliveries.findByMessageId(message.message_id)).toBeNull();
        await expect(
          deliveries.enqueueForMessageInTransaction(db, {
            ...assistantMessage(otherSession.session_id, 1),
            task_id: task.task_id,
          })
        ).resolves.toBeNull();
      }),
  ],
  [
    'reports stale authority for occurrences verified across a configuration change',
    (h) =>
      h.a(async (db) => {
        const { channel } = await seedTeamsGateway(db);
        const inbound = new GatewayInboundEventRepository(db);
        const addresses = new TeamsConversationAddressRepository(db);
        await inbound.admitVerifiedHttp(teamsAdmission(channel));
        const refreshedBefore = await addresses.findByChannelAndThread(channel.id, TEAMS_THREAD_ID);
        const changed = await editChannel(db, channel, POLICY_EDITS['config-change']);
        expect(changed.provider_config_generation).toBeGreaterThan(
          channel.provider_config_generation
        );

        // Verified under the old generation while the edit committed.
        const raced = inbound.admitVerifiedHttp(teamsAdmission(channel, 'teams:activity:raced'));
        await expect(raced).rejects.toBeInstanceOf(TeamsInboundAuthorityChangedError);
        await expect(raced).rejects.toMatchObject({ reason: 'stale_generation' });
        expect(await inbound.findByProviderEvent(channel.id, 'teams:activity:raced')).toBeNull();

        // A provider retry of the stored occurrence, now verified under the new generation.
        await expect(inbound.admitVerifiedHttp(teamsAdmission(changed))).rejects.toMatchObject({
          reason: 'stale_generation',
        });
        expect(await addresses.findByChannelAndThread(channel.id, TEAMS_THREAD_ID)).toEqual(
          refreshedBefore
        );
      }),
  ],
  [
    'terminalizes an expired encrypted payload after its channel is disabled',
    async (h) => {
      const { channel } = await h.a(seedTeamsGateway);
      const admitted = await h.a(async (db) => {
        const result = await new GatewayInboundEventRepository(db).admitVerifiedHttp({
          ...teamsAdmission(channel, 'teams:activity:expired'),
          payloadTtlMs: 1,
        });
        await new GatewayChannelRepository(db).update(channel.id, { enabled: false });
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const due = await h.system('teams_gateway_ingress_discovery', (db) =>
        new GatewayInboundEventRepository(db).findDueTeamsRefs(db, { limit: 100, now: new Date() })
      );
      expect(due.filter((ref) => ref.gateway_channel_id === channel.id)).toEqual([
        {
          tenant_id: h.tenantId,
          gateway_channel_id: channel.id,
          thread_id: TEAMS_THREAD_ID,
          event_id: admitted.event.id,
        },
      ]);
      if (h.foreign) {
        expect(
          await h.foreign((db) =>
            new GatewayInboundEventRepository(db).claimQueued(
              admitted.event.id,
              'wrong-tenant-claim',
              30_000
            )
          )
        ).toBeNull();
      }
      const stored = await h.a(async (db) => {
        const inbound = new GatewayInboundEventRepository(db);
        expect(await inbound.claimQueued(admitted.event.id, 'expiry-claim', 30_000)).toBeNull();
        return inbound.findByProviderEvent(channel.id, 'teams:activity:expired');
      });
      expect(stored).toMatchObject({
        status: 'dead_letter',
        payload_encrypted: null,
        payload_expires_at: null,
        last_error_code: 'payload_expired',
      });
    },
  ],
  [
    'dead-letters a permanent inbound fence and erases its queued payload',
    (h) =>
      h.a(async (db) => {
        const { channel } = await seedTeamsGateway(db);
        const inbound = new GatewayInboundEventRepository(db);
        const admitted = await inbound.admitVerifiedHttp(
          teamsAdmission(channel, 'teams:activity:permanent')
        );
        expect(
          await inbound.claimQueued(admitted.event.id, 'permanent-claim', 30_000)
        ).toBeTruthy();
        expect(
          await inbound.failQueued({
            eventId: admitted.event.id,
            processingToken: 'permanent-claim',
            status: 'dead_letter',
            errorCode: 'teams_payload_identity_mismatch',
          })
        ).toBe(true);
        expect(
          await inbound.findByProviderEvent(channel.id, 'teams:activity:permanent')
        ).toMatchObject({
          status: 'dead_letter',
          payload_encrypted: null,
          payload_expires_at: null,
          last_error_code: 'teams_payload_identity_mismatch',
        });
      }),
  ],
  [
    'admits a Task while the current event and channel fences are held',
    (h) =>
      h.a(async (db) => {
        const { channel, session } = await seedTeamsGateway(db);
        const inbound = new GatewayInboundEventRepository(db);
        const admitted = await inbound.admitVerifiedHttp(teamsAdmission(channel));
        const claim = await inbound.claimQueued(admitted.event.id, 'current-worker', 30_000);
        if (!claim) throw new Error('missing claim');
        const task = await runDatabaseTransaction(
          db,
          async (tx) => {
            await new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(claim);
            return new TaskRepository(tx).createPending({
              status: TaskStatus.QUEUED,
              session_id: session.session_id,
              full_prompt: 'current',
              created_by: session.created_by!,
            });
          },
          { sqliteImmediate: true }
        );
        expect(task.session_id).toBe(session.session_id);
        expect(
          await select(db).from(tasks).where(eq(tasks.session_id, session.session_id)).all()
        ).toHaveLength(1);
      }),
  ],
  [
    'reports a duplicate enabled Teams App ID as a Teams conflict',
    (h) =>
      h.a(async (db) => {
        const { appId, channel } = await seedTeamsGateway(db);
        const duplicate = 'Cannot enable Teams gateway channel: this Teams application';
        await expect(seedTeamsGateway(db, { appId })).rejects.toThrow(duplicate);
        await expect(
          new GatewayChannelRepository(db).create({
            name: 'Teams duplicate',
            created_by: channel.created_by,
            target_branch_id: channel.target_branch_id,
            agor_user_id: channel.agor_user_id,
            channel_type: 'teams',
            enabled: true,
            provider_installation_id: appId,
            config: { ...channel.config, app_password: 'teams-app-secret' },
          })
        ).rejects.toThrow(duplicate);
      }),
  ],
  ...admissionFenceCases,
  ...effectFenceCases,
];
