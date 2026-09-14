import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UUID } from '../../types/id';
import { TaskStatus } from '../../types/task';
import { createDatabase, type Database } from '../client';
import { isPostgresDatabase } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)('TaskRepository PostgreSQL', () => {
  let db: Database;
  let dbB: Database;
  const originalTimezone = process.env.TZ;

  beforeAll(async () => {
    process.env.TZ = 'America/Sao_Paulo';
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    await db.execute(sql`SET TIME ZONE 'America/Sao_Paulo'`);
  });

  afterAll(async () => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await Promise.all([
      (db as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
    ]);
  });

  it('preserves the claimed UTC instant across an idempotent reread in a non-UTC timezone', async () => {
    expect(new Date('2026-07-11T00:00:00').getTimezoneOffset()).toBe(180);

    const ownerId = generateId() as UUID;
    await new UsersRepository(db).create({
      user_id: ownerId,
      email: `postgres-task-${generateId()}@example.invalid`,
      role: 'member',
    });

    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `postgres-task-claim-${Date.now()}`,
      name: 'Postgres task claim',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/postgres-task-claim.git',
      local_path: '/tmp/postgres-task-claim',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'postgres-task-claim',
      ref: 'main',
      branch_unique_id: 1888,
      path: '/tmp/postgres-task-claim/branch',
      created_by: ownerId,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: ownerId,
    });
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      task_id: generateId(),
      session_id: session.session_id,
      created_by: ownerId,
      full_prompt: 'postgres timestamp regression',
      status: TaskStatus.DISPATCHING,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'postgres-test' },
      tool_use_count: 0,
    });
    const secondTask = await tasks.create({
      task_id: generateId(),
      session_id: session.session_id,
      created_by: ownerId,
      full_prompt: 'postgres SQL page regression',
      status: TaskStatus.COMPLETED,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'postgres-test' },
      tool_use_count: 0,
    });
    const taskPage = await tasks.findPage({
      sessionId: session.session_id,
      sort: { task_id: 1 },
      limit: 1,
      skip: 1,
    });
    expect(taskPage).toMatchObject({ total: 2 });
    expect(taskPage.data.map((row) => row.task_id)).toEqual(
      [task.task_id, secondTask.task_id].sort().slice(1)
    );

    const beforeClaim = Date.now();
    const first = await tasks.connectExecutor(task.task_id);
    const second = await tasks.connectExecutor(task.task_id);
    const afterClaim = Date.now();

    expect(first?.transitioned).toBe(true);
    expect(second).toEqual({ task: first?.task, transitioned: false });
    expect(first?.task.last_executor_heartbeat_at).toBe(first?.task.executor_connected_at);
    const connectedAt = Date.parse(first!.task.executor_connected_at!);
    // PostgreSQL retains microseconds while the driver exposes JavaScript
    // milliseconds; flooring that round-trip can land one millisecond before
    // the client-side wall-clock sample taken immediately before the claim.
    expect(connectedAt).toBeGreaterThanOrEqual(beforeClaim - 1);
    expect(connectedAt).toBeLessThanOrEqual(afterClaim);

    await Promise.allSettled([
      tasks.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
      }),
      tasks.updateFromExecutor(task.task_id, { status: TaskStatus.AWAITING_INPUT }),
    ]);
    expect(await tasks.findById(task.task_id)).toMatchObject({
      status: TaskStatus.STOPPING,
      termination_request: { cause: 'user_stop' },
    });
    await expect(tasks.updateFromExecutor(task.task_id, { model: 'late' })).rejects.toThrow(
      'not connected and executor-writable'
    );

    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    const columns = await db.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tasks'
        AND column_name IN ('executor_connected_at', 'last_executor_heartbeat_at')
      ORDER BY column_name
    `);
    expect(columns).toEqual([
      { column_name: 'executor_connected_at', data_type: 'timestamp with time zone' },
      { column_name: 'last_executor_heartbeat_at', data_type: 'timestamp with time zone' },
    ]);
  });

  it('serializes the missing-actor terminalization command against dispatch', async () => {
    const owner = await new UsersRepository(db).create({
      email: `postgres-queue-owner-${generateId()}@example.invalid`,
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `postgres-queue-race-${generateId()}`,
      name: 'Postgres queue actor race',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/postgres-queue-race.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `postgres-queue-race-${generateId()}`,
      ref: 'main',
      branch_unique_id: (Date.now() + 31) % 1_000_000,
      path: `/tmp/${generateId()}`,
      created_by: owner.user_id,
    });
    const sessions = new SessionRepository(db);
    const tasksA = new TaskRepository(db);
    const tasksB = new TaskRepository(dbB);

    const deletedActor = await new UsersRepository(db).create({
      email: `postgres-deleted-queue-actor-${generateId()}@example.invalid`,
      role: 'member',
    });
    const deletedSession = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: owner.user_id,
    });
    const deletedTask = await tasksA.createPending({
      session_id: deletedSession.session_id,
      full_prompt: 'delete-first queue actor',
      created_by: deletedActor.user_id,
      status: TaskStatus.QUEUED,
    });
    await new UsersRepository(db).delete(deletedActor.user_id);
    const deleteFirst = await Promise.all([
      tasksA.failQueuedTaskIfCreatorMissing(deletedTask.task_id),
      tasksB.claimDispatchAndProjectSession(deletedTask.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      }),
    ]);
    expect(deleteFirst.filter((result) => result.outcome === 'actor_missing')).toHaveLength(1);
    expect(deleteFirst.filter((result) => result.outcome === 'condition_changed')).toHaveLength(1);
    await expect(tasksA.findById(deletedTask.task_id)).resolves.toMatchObject({
      status: TaskStatus.FAILED,
      queue_position: undefined,
    });

    const liveActor = await new UsersRepository(db).create({
      email: `postgres-live-queue-actor-${generateId()}@example.invalid`,
      role: 'member',
    });
    const liveSession = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: owner.user_id,
    });
    const liveTask = await tasksA.createPending({
      session_id: liveSession.session_id,
      full_prompt: 'claim-first queue actor',
      created_by: liveActor.user_id,
      status: TaskStatus.QUEUED,
    });
    const claimFirst = await Promise.all([
      tasksA.claimDispatchAndProjectSession(liveTask.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      }),
      tasksB.failQueuedTaskIfCreatorMissing(liveTask.task_id),
    ]);
    expect(claimFirst.some((result) => result.outcome === 'claimed')).toBe(true);
    expect(claimFirst.every((result) => result.outcome !== 'actor_missing')).toBe(true);
    await new UsersRepository(db).delete(liveActor.user_id);
    await expect(tasksA.findById(liveTask.task_id)).resolves.toMatchObject({
      status: TaskStatus.DISPATCHING,
      queue_position: undefined,
    });
  });

  it('serializes exact Slack recovery notice consumption under PostgreSQL row locks', async () => {
    const label = crypto.randomUUID();
    const owner = await new UsersRepository(db).create({
      email: `postgres-slack-recovery-${label}@example.invalid`,
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `postgres-slack-recovery-${label}`,
      name: 'Postgres Slack recovery',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/postgres-slack-recovery.git',
      local_path: `/tmp/postgres-slack-recovery-${label}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `postgres-slack-recovery-${label}`,
      ref: 'main',
      branch_unique_id: 100_000 + Math.floor(Math.random() * 900_000),
      path: `/tmp/postgres-slack-recovery-${label}/branch`,
      created_by: owner.user_id,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: owner.user_id,
    });
    const tasks = new TaskRepository(db);
    const taskId = generateId();
    await tasks.create({
      task_id: taskId,
      session_id: session.session_id,
      created_by: owner.user_id,
      full_prompt: 'postgres Slack recovery CAS',
      status: TaskStatus.RUNNING,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'postgres-test' },
      tool_use_count: 0,
      metadata: {
        mcp_slack_recovery_notice: {
          notice_id: 'notice-postgres',
          token_jti: 'jti-postgres',
          issued_at: '2026-08-26T12:00:00.000Z',
          expires_at: '2026-08-26T12:10:00.000Z',
          principal_user_id: owner.user_id,
          credential_user_id: owner.user_id,
          slack_user_id: 'U1',
          slack_team_id: 'T1',
          gateway_channel_id: 'gateway-1',
          gateway_config_generation: 1,
          slack_channel_id: 'C1',
          slack_thread_id: 'C1-1.1',
          session_id: session.session_id,
          task_id: taskId,
          mcp_server_id: generateId() as never,
          mcp_server_config_version: 1,
          recovery_generation: 2,
          recovery_request_id: 'request-postgres',
          provider_dispatch: 'not_started',
          delivery_id: 'delivery-postgres',
          next_repair_at: '2026-08-26T12:00:00.000Z',
        },
      },
    });

    const consume = () =>
      tasks.mutateMCPSlackRecoveryNotice(taskId, (current) =>
        current?.notice_id === 'notice-postgres' &&
        current.token_jti === 'jti-postgres' &&
        current.recovery_request_id === 'request-postgres' &&
        !current.token_consumed_at
          ? { ...current, token_consumed_at: '2026-08-26T12:01:00.000Z' }
          : null
      );
    const results = await Promise.all([consume(), consume()]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    const due = await tasks.findMcpSlackRecoveryNoticePage({
      now: new Date('2026-08-26T12:02:00.000Z'),
      horizon: new Date('2026-08-25T12:02:00.000Z'),
      limit: 1,
    });
    expect(due.tasks.map((candidate) => candidate.task_id)).toContain(taskId);

    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    const columns = await db.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tasks'
        AND column_name = 'mcp_slack_recovery_due_at'
    `);
    expect(columns).toEqual([
      { column_name: 'mcp_slack_recovery_due_at', data_type: 'timestamp with time zone' },
    ]);
    const indexes = await db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'tasks'
        AND indexname = 'tasks_mcp_slack_recovery_due_idx'
    `);
    expect(indexes).toEqual([{ indexname: 'tasks_mcp_slack_recovery_due_idx' }]);
  });
});
