/**
 * One Session, two Slack threads — the shape gateway reply routing used to get
 * wrong.
 *
 * `thread_session_map` is unique on `(channel_id, thread_id)` and merely
 * indexed on `session_id`, so a Session may own several threads. Outbound
 * routing nonetheless asked "which thread does this Session belong to?", which
 * has no answer here: the underlying read was an unordered single-row fetch
 * (`.get()` on SQLite, an unordered `LIMIT 1` on PostgreSQL) and returned
 * whichever row the engine happened to hand back. A private answer could
 * therefore be delivered into a public thread.
 *
 * These rows are seeded directly rather than admitted through `create`,
 * because admission is exactly what refuses to produce a second mapping today.
 * That refusal is the reason the defect is latent — not a reason it is absent,
 * and pinning a Session as several threads' front desk removes it.
 *
 * Shared by the SQLite and PostgreSQL suites because the broken read differed
 * between the two engines, so proving the fix on one proves nothing about the
 * other.
 */

import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  GatewayChannelRepository,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  threadSessionMap,
  UsersRepository,
  update,
} from '@agor/core/db';
import type {
  BranchID,
  GatewayChannel,
  SessionID,
  Task,
  TaskID,
  TenantID,
  ThreadSessionMap,
  UUID,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { GatewayService } from '../src/services/gateway';

/** Single-tenant on both engines: these suites are not about tenant isolation. */
export const REPLY_ROUTING_TENANT = 'default';

/** Public room. A reply that lands here is readable by everyone in it. */
export const PUBLIC_THREAD = 'C1PUBLIC-1700000000.000001';
/** Direct message. The thread the private answers in these suites belong in. */
export const DM_THREAD = 'D1PRIVATE-1700000000.000002';
/**
 * A proactive seed's own thread, plus the inbound alias a human reply arrives
 * on. The mapping is keyed on the seed thread while the Task records the
 * alias, which is why re-deriving the destination from
 * `gateway_task_source.thread_id` is not a substitute for stamping the
 * mapping's id.
 */
export const SEED_THREAD = 'C1SEEDED-1700000000.000003';
export const SEED_INBOUND_ALIAS = 'C1SEEDED-1700000000.000009';

export interface GatewayReplyRoutingFixture {
  channel: GatewayChannel;
  sessionId: SessionID;
  /** First mapping written, and therefore the one an unordered read favours. */
  publicMapping: ThreadSessionMap;
  /** Second mapping written; the destination the stamped Tasks actually mean. */
  dmMapping: ThreadSessionMap;
  seedMapping: ThreadSessionMap;
  /** Stamped with `dmMapping`. Its reply belongs in the DM and nowhere else. */
  dmTask: Task;
  /** Stamped with `publicMapping`, to prove the resolver is not simply biased. */
  publicTask: Task;
  /** Stamped with `seedMapping` while recording the inbound alias thread. */
  seedTask: Task;
  /**
   * Carries gateway coordinates but no stamp, as every Task admitted before
   * the stamp existed does. Must still route rather than refuse.
   */
  unstampedTask: Task;
}

/**
 * Seed a Slack channel whose Session serves three threads, plus one Task per
 * thread carrying that thread's mapping id.
 */
export async function seedGatewayReplyRouting(
  db: Database,
  tenantId: TenantID | string
): Promise<GatewayReplyRoutingFixture> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      user_id: generateId() as UUID,
      email: `reply-routing-${generateId()}@example.invalid`,
      name: 'Reply routing fixture',
      role: 'admin',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId() as UUID,
      slug: `reply-routing-${generateId()}`,
      name: 'Reply routing fixture',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/reply-routing.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: `reply-routing-${generateId()}`,
      ref: 'refs/heads/main',
      branch_unique_id: Date.now() % 1_000_000_000,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const channel = await new GatewayChannelRepository(scoped).create({
      id: generateId() as UUID,
      name: 'Reply routing fixture',
      channel_type: 'slack',
      channel_key: `reply-routing-${generateId()}`,
      enabled: true,
      target_branch_id: branch.branch_id as UUID,
      agor_user_id: user.user_id,
      created_by: user.user_id,
      config: {
        bot_token: 'xoxb-reply-routing',
        app_token: 'xapp-reply-routing',
        align_slack_users: false,
        allowed_channel_ids: ['C1PUBLIC', 'D1PRIVATE', 'C1SEEDED'],
      },
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id as BranchID,
      created_by: user.user_id,
      status: SessionStatus.IDLE,
      title: 'Front desk',
      tasks: [],
    });

    const mappings = new ThreadSessionMapRepository(scoped);
    // Insertion order matters: the public room goes in first so that an
    // unordered engine read is overwhelmingly likely to return it, which is
    // what makes the DM assertions below fail against the unfixed code rather
    // than pass by luck.
    const publicMapping = await mappings.create({
      channel_id: channel.id,
      thread_id: PUBLIC_THREAD,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    });
    const dmMapping = await mappings.create({
      channel_id: channel.id,
      thread_id: DM_THREAD,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    });
    const seedMapping = await mappings.create({
      channel_id: channel.id,
      thread_id: SEED_THREAD,
      session_id: session.session_id,
      branch_id: branch.branch_id,
      metadata: { gateway_reply_aliases: [SEED_INBOUND_ALIAS] },
    });

    const tasks = new TaskRepository(scoped);
    const makeTask = (mapping: ThreadSessionMap | null, recordedThreadId: string, prompt: string) =>
      tasks.create({
        task_id: generateId() as TaskID,
        session_id: session.session_id,
        created_by: user.user_id,
        full_prompt: prompt,
        status: TaskStatus.COMPLETED,
        metadata: {
          gateway_task_source: {
            gateway_channel_id: channel.id,
            channel_type: 'slack',
            thread_id: recordedThreadId,
            provider_user_id: 'U1HUMAN',
            ...(mapping ? { thread_session_map_id: mapping.id } : {}),
          },
        },
      });

    return {
      channel,
      sessionId: session.session_id as SessionID,
      publicMapping,
      dmMapping,
      seedMapping,
      dmTask: await makeTask(dmMapping, DM_THREAD, 'what is my api key'),
      publicTask: await makeTask(publicMapping, PUBLIC_THREAD, 'status update please'),
      seedTask: await makeTask(seedMapping, SEED_INBOUND_ALIAS, 'replying to your nudge'),
      unstampedTask: await makeTask(null, DM_THREAD, 'admitted before the stamp existed'),
    };
  });
}

/** The minimum Feathers surface `routeMessage` touches on a direct call. */
export function replyRoutingApp() {
  return {
    get: (name: string) =>
      name === 'distributedWorkIdentity'
        ? { instanceId: 'reply-routing-test', bootId: 'reply-routing-boot' }
        : undefined,
    service: (name: string) => {
      throw new Error(`Unexpected service: ${name}`);
    },
  };
}

/** One outbound send a fake connector observed. */
export interface RecordedSend {
  threadId: string;
  text: string;
}

export interface ReplyRoutingScenario {
  name: string;
  run(db: Database, sends: RecordedSend[]): Promise<void>;
}

async function start(db: Database, sends: RecordedSend[]) {
  sends.length = 0;
  const fixture = await seedGatewayReplyRouting(db, REPLY_ROUTING_TENANT);
  const service = new GatewayService(
    createTenantScopedDatabaseProxy(db, { requireScope: true, label: 'reply routing test' }),
    replyRoutingApp() as never
  );
  const scoped = <T>(work: (scopedDb: Database) => Promise<T>) =>
    runWithTenantDatabaseScope(db, REPLY_ROUTING_TENANT, work);
  await scoped(() => service.refreshChannelState());
  const route = (data: { task_id?: TaskID; message: string }) =>
    scoped(() => service.routeMessage({ session_id: fixture.sessionId, ...data }));
  return { fixture, service, scoped, route };
}

/**
 * The assertions both engine suites run, written once.
 *
 * Kept here rather than duplicated per engine because the statement this
 * change fixes was engine-specific — `.get()` versus an unordered `LIMIT 1` —
 * so any drift between the two lanes would silently retire half the coverage.
 */
export const replyRoutingScenarios: ReplyRoutingScenario[] = [
  {
    name: 'delivers a DM answer to the DM, not to the session’s other thread',
    async run(db, sends) {
      const { fixture, route } = await start(db, sends);

      await route({ task_id: fixture.dmTask.task_id, message: 'your key is in the vault' });

      expect(sends).toEqual([{ threadId: DM_THREAD, text: 'your key is in the vault' }]);
    },
  },
  {
    name: 'is not merely biased toward one mapping',
    async run(db, sends) {
      const { fixture, route } = await start(db, sends);

      await route({ task_id: fixture.publicTask.task_id, message: 'all green' });
      await route({ task_id: fixture.dmTask.task_id, message: 'your key is in the vault' });

      expect(sends.map((sent) => sent.threadId)).toEqual([PUBLIC_THREAD, DM_THREAD]);
    },
  },
  {
    name: 'routes a seed-originated thread by its stamp, not its inbound alias',
    async run(db, sends) {
      // The Task records the alias the human replied on while the mapping is
      // keyed on the seed's own thread, so re-deriving the destination from
      // the Task's `thread_id` finds nothing. Only the stamp answers.
      const { fixture, route } = await start(db, sends);

      await route({ task_id: fixture.seedTask.task_id, message: 'on it' });

      expect(sends).toEqual([{ threadId: SEED_THREAD, text: 'on it' }]);
    },
  },
  {
    name: 'still routes a message carrying no Task attribution',
    async run(db, sends) {
      const { route } = await start(db, sends);

      const result = await route({ message: 'legacy row, no task_id' });

      expect(result).toEqual({ routed: true, channelType: 'slack' });
      expect(sends).toHaveLength(1);
    },
  },
  {
    name: 'still routes a Task admitted before the stamp existed',
    async run(db, sends) {
      const { fixture, route } = await start(db, sends);

      const result = await route({
        task_id: fixture.unstampedTask.task_id,
        message: 'pre-stamp task',
      });

      // Unstamped, but its recorded coordinates suffice: the Task names the DM
      // thread and `(channel_id, thread_id)` is unique, so the reply lands
      // there rather than on the Session's arbitrary first mapping.
      expect(result).toEqual({ routed: true, channelType: 'slack' });
      expect(sends).toEqual([{ threadId: DM_THREAD, text: 'pre-stamp task' }]);
    },
  },
  {
    name: 'refuses a stamp that now points at another session',
    async run(db, sends) {
      const { fixture, scoped, route } = await start(db, sends);
      // A mapping repointed at a different Session has stopped being this
      // Task's reply address, whatever the Task still remembers.
      const other = await seedGatewayReplyRouting(db, REPLY_ROUTING_TENANT);
      // Written as SQL because `ThreadSessionMapRepository.update` cannot move
      // a mapping between sessions, which is the state being simulated.
      await scoped(async (scopedDb: Database) => {
        await update(scopedDb, threadSessionMap)
          .set({ session_id: other.sessionId })
          .where(eq(threadSessionMap.id, fixture.dmMapping.id))
          .run();
      });

      const result = await route({ task_id: fixture.dmTask.task_id, message: 'stale stamp' });

      expect(result).toEqual({ routed: false });
      expect(sends).toEqual([]);
    },
  },
  {
    name: 'does not send a deleted destination to another thread',
    async run(db, sends) {
      const { fixture, scoped, route } = await start(db, sends);
      await scoped((scopedDb) =>
        new ThreadSessionMapRepository(scopedDb).delete(fixture.dmMapping.id)
      );
      for (const task of [fixture.dmTask, fixture.unstampedTask]) {
        expect(await route({ task_id: task.task_id, message: 'private' })).toEqual({
          routed: false,
        });
      }
      expect(sends).toEqual([]);
    },
  },
  {
    name: 'resolves a pre-stamp seed Task through its reply alias',
    async run(db, sends) {
      const { fixture, scoped, route } = await start(db, sends);
      await scoped((scopedDb) =>
        new TaskRepository(scopedDb).update(fixture.seedTask.task_id, {
          metadata: {
            gateway_task_source: {
              ...fixture.seedTask.metadata!.gateway_task_source!,
              thread_session_map_id: undefined,
            },
          },
        })
      );
      await route({ task_id: fixture.seedTask.task_id, message: 'legacy alias' });
      expect(sends).toEqual([{ threadId: SEED_THREAD, text: 'legacy alias' }]);
    },
  },
  {
    name: 'propagates a destination read failure without sending elsewhere',
    async run(db, sends) {
      const { fixture, route } = await start(db, sends);
      const read = vi
        .spyOn(ThreadSessionMapRepository.prototype, 'findById')
        .mockRejectedValueOnce(new Error('read unavailable'));
      try {
        await expect(
          route({ task_id: fixture.dmTask.task_id, message: 'private' })
        ).rejects.toThrow('read unavailable');
        expect(sends).toEqual([]);
      } finally {
        read.mockRestore();
      }
    },
  },
];
