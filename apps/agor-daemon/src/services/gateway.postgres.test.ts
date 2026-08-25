import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { getBaseUrl } from '@agor/core/config';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  GatewayChannelRepository,
  GatewayOutboundMessageRepository,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  ThreadSessionMapRepository,
  UsersRepository,
} from '@agor/core/db';
import { getConnector } from '@agor/core/gateway';
import type { Session, TaskID, TenantID, User } from '@agor/core/types';
import { DEFAULT_DISCORD_CATCH_UP, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gatewayInboundTaskId } from '../utils/durable-task-id.js';
import { GatewayService } from './gateway.js';

vi.mock('@agor/agentic-tools/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/agentic-tools/config')>();
  return {
    ...actual,
    materializeAgenticToolConfiguration: vi.fn(async () => ({
      agentic_tool_preset_id: null,
      permission_config: { mode: 'default' },
      model_config: null,
    })),
  };
});

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    getBaseUrl: vi.fn(async () => 'https://agor.example.com'),
  };
});

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(() => ({
      sendMessage: vi.fn(async () => ({ messageId: 'system-message' })),
    })),
  };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const authorId = '444444444444444444';
const botId = '111111111111111111';
let activeBotId = botId;
let botInstallationCounter = 0n;
const guildId = '222222222222222222';
const channelId = '333333333333333333';
const seedThreadId = `discord:message:${channelId}:555555555555555555`;
const aliasOne = `discord:message:${channelId}:666666666666666666`;
const aliasTwo = `discord:message:${channelId}:777777777777777777`;

function discordInboundData(
  channelKey: string,
  threadId: string,
  messageId: string,
  identities: { eventId?: string; idempotencySessionId?: string; idempotencyTaskId?: string } = {}
) {
  return {
    channel_key: channelKey,
    thread_id: threadId,
    text: `reply for ${messageId}`,
    user_name: authorId,
    gateway_inbound_event_id: identities.eventId ?? generateId(),
    ...(identities.idempotencySessionId
      ? { idempotency_session_id: identities.idempotencySessionId }
      : {}),
    ...(identities.idempotencyTaskId ? { idempotency_task_id: identities.idempotencyTaskId } : {}),
    metadata: {
      discord_guild_id: guildId,
      discord_author_id: authorId,
      discord_bot_user_id: activeBotId,
      discord_channel_id: channelId,
      discord_message_id: messageId,
      discord_role_ids: [],
      discord_has_mention: true,
      discord_is_thread: false,
      discord_reply_to_message_id: messageId,
    },
  };
}

async function seedGateway(db: Database, tenantId: TenantID) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const users = new UsersRepository(scoped);
    const repos = new RepoRepository(scoped);
    const branches = new BranchRepository(scoped);
    const channels = new GatewayChannelRepository(scoped);
    const outbound = new GatewayOutboundMessageRepository(scoped);
    activeBotId = (BigInt(botId) + botInstallationCounter++).toString();

    const user = await users.create({
      user_id: generateId(),
      email: `${tenantId}@example.com`,
      name: 'Discord gateway race',
      role: 'admin',
    });
    const repo = await repos.create({
      repo_id: generateId(),
      slug: `discord-gateway-${generateId()}`,
      name: 'Discord gateway race',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/discord-gateway.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `discord-gateway-${generateId()}`,
      ref: 'main',
      branch_unique_id: Date.now() % 1_000_000_000,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const channel = await channels.create({
      id: generateId(),
      name: 'Discord gateway race',
      channel_type: 'discord',
      channel_key: `discord-race-${generateId()}`,
      enabled: true,
      target_branch_id: branch.branch_id,
      agor_user_id: user.user_id,
      created_by: user.user_id,
      config: {
        bot_token: 'discord-test-token',
        application_id: activeBotId,
        guild_id: guildId,
        allowed_channel_ids: [channelId],
        allowed_user_ids: [authorId],
        allowed_role_ids: [],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        align_discord_users: false,
        catch_up: { ...DEFAULT_DISCORD_CATCH_UP },
        files: false,
        agent_tools: [],
      },
      provider_installation_id: activeBotId,
    });
    const seed = await outbound.create({
      gateway_channel_id: channel.id,
      channel_type: 'discord',
      platform_channel_id: channelId,
      platform_message_id: '555555555555555555',
      platform_thread_id: seedThreadId,
      target_branch_id: branch.branch_id,
      emitted_by_user_id: user.user_id,
      message_text: 'seed',
      message_preview: 'seed',
      metadata: { provider_reply_aliases: [aliasOne, aliasTwo] },
    });
    return { branch, channel, seed, user };
  });
}

function makeApp(
  db: Database,
  tenantId: TenantID,
  user: User,
  options?: { persistPromptTasks?: boolean }
) {
  const withTenant = <T>(work: (scoped: Database) => Promise<T>) =>
    runWithTenantDatabaseScope(db, tenantId, work);
  const promptCreate = vi.fn(
    async (
      data: { prompt: string; idempotencyTaskId?: TaskID; metadata?: unknown },
      params: { route: { id: string } }
    ) => {
      if (options?.persistPromptTasks && data.idempotencyTaskId) {
        return withTenant((scoped) =>
          new TaskRepository(scoped).create({
            task_id: data.idempotencyTaskId,
            session_id: params.route.id,
            created_by: user.user_id,
            full_prompt: data.prompt,
            status: TaskStatus.RUNNING,
            metadata: data.metadata as never,
          })
        );
      }
      return {
        task_id: generateId() as TaskID,
        session_id: params.route.id,
        status: 'running',
      };
    }
  );

  return {
    promptCreate,
    app: {
      get: (name: string) =>
        name === 'distributedWorkIdentity'
          ? { instanceId: 'postgres-test', bootId: 'postgres-test-boot' }
          : undefined,
      service: (name: string) => {
        if (name === 'users') return { get: vi.fn(async () => user) };
        if (name === 'sessions') {
          return {
            create: (data: Partial<Session>) =>
              withTenant((scoped) => new SessionRepository(scoped).create(data)),
            get: (id: string) => withTenant((scoped) => new SessionRepository(scoped).findById(id)),
            patch: vi.fn(async () => undefined),
            setMCPServers: vi.fn(async () => undefined),
          };
        }
        if (name === '/sessions/:id/prompt') return { create: promptCreate };
        throw new Error(`Unexpected service: ${name}`);
      },
    },
  };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('gateway reply admission (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    process.env.AGOR_MASTER_SECRET ||= 'gateway-postgres-test-secret';
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('admits one stable session for concurrent aliases and rejects a cross-tenant lookup', async () => {
    const tenantId = `gateway-race-${generateId()}` as TenantID;
    const otherTenantId = `gateway-other-${generateId()}` as TenantID;
    const { channel, seed, user } = await seedGateway(db, tenantId);
    const { app, promptCreate } = makeApp(db, tenantId, user);
    const service = new GatewayService(
      createTenantScopedDatabaseProxy(db, { requireScope: true, label: 'gateway race test' }),
      app as never
    );

    const firstEventId = generateId();
    const secondEventId = generateId();
    const firstIdempotencySessionId = generateId();
    const secondIdempotencySessionId = generateId();
    const [first, second] = await Promise.all([
      runWithTenantDatabaseScope(db, tenantId, () =>
        service.create(
          discordInboundData(channel.channel_key, aliasOne, '666666666666666666', {
            eventId: firstEventId,
            idempotencySessionId: firstIdempotencySessionId,
          })
        )
      ),
      runWithTenantDatabaseScope(db, tenantId, () =>
        service.create(
          discordInboundData(channel.channel_key, aliasTwo, '777777777777777777', {
            eventId: secondEventId,
            idempotencySessionId: secondIdempotencySessionId,
          })
        )
      ),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.sessionId).toBe(second.sessionId);
    expect(promptCreate).toHaveBeenCalledTimes(2);

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const sessions = await new SessionRepository(scoped).findAll();
      const mappings = await new ThreadSessionMapRepository(scoped).findByChannel(channel.id);
      const admittedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(sessions).toHaveLength(1);
      expect(sessions.map((session) => session.session_id)).toEqual([first.sessionId]);
      expect(await new SessionRepository(scoped).findById(firstIdempotencySessionId)).toBeNull();
      expect(await new SessionRepository(scoped).findById(secondIdempotencySessionId)).toBeNull();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].thread_id).toBe(seedThreadId);
      expect(mappings[0].session_id).toBe(first.sessionId);
      expect(admittedSeed?.consumed_by_session_id).toBe(first.sessionId);
      expect(admittedSeed?.metadata).toMatchObject({
        provider_reply_aliases: expect.arrayContaining([aliasOne, aliasTwo]),
      });
    });

    await expect(
      runWithTenantDatabaseScope(db, otherTenantId, () =>
        service.create(discordInboundData(channel.channel_key, aliasOne, '666666666666666666'))
      )
    ).rejects.toThrow('Invalid channel_key');

    await runWithTenantDatabaseScope(db, otherTenantId, async (scoped) => {
      expect(await new SessionRepository(scoped).findAll()).toHaveLength(0);
      expect(await new ThreadSessionMapRepository(scoped).findByChannel(channel.id)).toHaveLength(
        0
      );
      expect(await new GatewayOutboundMessageRepository(scoped).findById(seed.id)).toBeNull();
    });

    expect(vi.mocked(materializeAgenticToolConfiguration)).toHaveBeenCalled();
    expect(vi.mocked(getBaseUrl)).toHaveBeenCalled();
    expect(vi.mocked(getConnector)).toHaveBeenCalled();
  }, 30_000);

  it('keeps Discord cursor reads and advances tenant-scoped', async () => {
    const tenantA = `cursor-owner-${generateId()}` as TenantID;
    const tenantB = `cursor-other-${generateId()}` as TenantID;
    const { channel, branch, user } = await seedGateway(db, tenantA);
    const mapping = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const session = await new SessionRepository(scoped).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        created_by: user.user_id,
        title: 'cursor isolation',
      });
      return new ThreadSessionMapRepository(scoped).create({
        channel_id: channel.id,
        thread_id: '900000000000000001',
        session_id: session.session_id,
        branch_id: branch.branch_id,
      });
    });

    await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new ThreadSessionMapRepository(scoped).advanceDiscordLastAdmittedMessageId(
        mapping.id,
        '900000000000000010'
      )
    );
    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const repo = new ThreadSessionMapRepository(scoped);
      await expect(repo.findById(mapping.id)).resolves.toBeNull();
      await expect(
        repo.advanceDiscordLastAdmittedMessageId(mapping.id, '900000000000000011')
      ).rejects.toThrow();
    });
    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      await expect(
        new ThreadSessionMapRepository(scoped).findById(mapping.id)
      ).resolves.toMatchObject({
        discord_last_admitted_message_id: '900000000000000010',
      });
    });
  }, 30_000);

  it('recovers after mapping persistence before seed completion on retry', async () => {
    const tenantId = `gateway-recovery-${generateId()}` as TenantID;
    const { channel, seed, user } = await seedGateway(db, tenantId);
    const { app, promptCreate } = makeApp(db, tenantId, user);
    const service = new GatewayService(
      createTenantScopedDatabaseProxy(db, { requireScope: true, label: 'gateway recovery test' }),
      app as never
    );
    const inbound = discordInboundData(channel.channel_key, aliasOne, '666666666666666666', {
      eventId: generateId(),
      idempotencySessionId: generateId(),
    });
    const outboundRepo = (service as unknown as { outboundRepo: GatewayOutboundMessageRepository })
      .outboundRepo;
    vi.spyOn(outboundRepo, 'completeReplyAdmission').mockRejectedValueOnce(
      new Error('simulated crash')
    );

    await expect(runWithTenantContext(tenantId, () => service.create(inbound))).rejects.toThrow(
      'simulated crash'
    );

    const reservedSessionId = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const sessions = await new SessionRepository(scoped).findAll();
      const mappings = await new ThreadSessionMapRepository(scoped).findByChannel(channel.id);
      const reservedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(sessions).toHaveLength(1);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].thread_id).toBe(seedThreadId);
      expect(mappings[0].session_id).toBe(reservedSeed?.metadata?.reply_session_admission_id);
      expect(mappings[0].metadata).toMatchObject({ outbound_seed_id: seed.id });
      expect(reservedSeed?.consumed_at).toBeNull();
      expect(reservedSeed?.metadata?.reply_session_admission_id).toEqual(expect.any(String));
      return reservedSeed?.metadata?.reply_session_admission_id as string;
    });

    await expect(
      runWithTenantContext(tenantId, () => service.create(inbound))
    ).resolves.toMatchObject({ success: true, sessionId: reservedSessionId });

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const sessions = await new SessionRepository(scoped).findAll();
      const mappings = await new ThreadSessionMapRepository(scoped).findByChannel(channel.id);
      const completedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].session_id).toBe(reservedSessionId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].session_id).toBe(reservedSessionId);
      expect(completedSeed?.consumed_by_session_id).toBe(reservedSessionId);
      expect(completedSeed?.consumed_at).not.toBeNull();
    });
    expect(promptCreate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('keeps seed completion bound to event A across an alias interleaving', async () => {
    const tenantId = `gateway-seed-prompt-${generateId()}` as TenantID;
    const { channel, seed, user } = await seedGateway(db, tenantId);
    const { app, promptCreate } = makeApp(db, tenantId, user, { persistPromptTasks: true });
    const service = new GatewayService(
      createTenantScopedDatabaseProxy(db, {
        requireScope: true,
        label: 'gateway seed prompt test',
      }),
      app as never
    );
    const eventA = generateId();
    const taskA = gatewayInboundTaskId(eventA as never);
    const inboundA = discordInboundData(channel.channel_key, aliasOne, '666666666666666666', {
      eventId: eventA,
      idempotencySessionId: generateId(),
      idempotencyTaskId: taskA,
    });
    const eventB = generateId();
    const taskB = gatewayInboundTaskId(eventB as never);
    const inboundB = discordInboundData(channel.channel_key, aliasTwo, '777777777777777777', {
      eventId: eventB,
      idempotencySessionId: generateId(),
      idempotencyTaskId: taskB,
    });
    const promptFailure = new Error(
      'prompt failed with discord-token AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC'
    );
    promptCreate.mockRejectedValueOnce(promptFailure);

    await expect(runWithTenantContext(tenantId, () => service.create(inboundA))).rejects.toBe(
      promptFailure
    );
    const seededPrompt = promptCreate.mock.calls[0][0].prompt;

    await expect(
      runWithTenantContext(tenantId, () => service.create(inboundB))
    ).resolves.toMatchObject({ success: true, created: false });
    expect(promptCreate.mock.calls[1][0].idempotencyTaskId).toBe(taskB);

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const mapping = await new ThreadSessionMapRepository(scoped).findByChannel(channel.id);
      const completedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(completedSeed?.consumed_at).not.toBeNull();
      expect(mapping[0]?.metadata).toMatchObject({
        outbound_seed_initial_prompt_pending: true,
        outbound_seed_initial_event_id: eventA,
      });
    });

    await expect(
      runWithTenantContext(tenantId, () => service.create(inboundA))
    ).resolves.toMatchObject({ success: true, taskId: taskA });
    expect(promptCreate).toHaveBeenCalledTimes(3);
    expect(promptCreate.mock.calls[2][0].idempotencyTaskId).toBe(taskA);
    expect(promptCreate.mock.calls[2][0].prompt).toBe(seededPrompt);

    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const mapping = await new ThreadSessionMapRepository(scoped).findByChannel(channel.id);
      const completedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(completedSeed?.consumed_at).not.toBeNull();
      expect(mapping[0]?.metadata).toMatchObject({
        outbound_seed_initial_prompt_pending: false,
        outbound_seed_initial_task_id: taskA,
      });
    });
  }, 30_000);

  it('reuses the stable admitted Task after prompt admission before inbound completion', async () => {
    const tenantId = `gateway-seed-task-${generateId()}` as TenantID;
    const { channel, seed, user } = await seedGateway(db, tenantId);
    const { app, promptCreate } = makeApp(db, tenantId, user, { persistPromptTasks: true });
    const service = new GatewayService(
      createTenantScopedDatabaseProxy(db, { requireScope: true, label: 'gateway seed task test' }),
      app as never
    );
    const eventId = generateId();
    const taskId = gatewayInboundTaskId(eventId as never);
    const inbound = discordInboundData(channel.channel_key, aliasOne, '666666666666666666', {
      eventId,
      idempotencySessionId: generateId(),
      idempotencyTaskId: taskId,
    });

    const first = await runWithTenantContext(tenantId, () => service.create(inbound));
    const retry = await runWithTenantContext(tenantId, () => service.create(inbound));

    expect(first).toMatchObject({ success: true, taskId });
    expect(retry).toMatchObject({ success: true, taskId, created: false });
    expect(promptCreate).toHaveBeenCalledOnce();
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const completedSeed = await new GatewayOutboundMessageRepository(scoped).findById(seed.id);
      expect(completedSeed?.consumed_by_session_id).toBe(first.sessionId);
      expect(completedSeed?.consumed_at).not.toBeNull();
      expect(await new ThreadSessionMapRepository(scoped).findByChannel(channel.id)).toHaveLength(
        1
      );
    });
  }, 30_000);
});
