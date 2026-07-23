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

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)('TaskRepository PostgreSQL', () => {
  let db: Database;
  const originalTimezone = process.env.TZ;

  beforeAll(async () => {
    process.env.TZ = 'America/Sao_Paulo';
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    await db.execute(sql`SET TIME ZONE 'America/Sao_Paulo'`);
  });

  afterAll(async () => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('preserves the claimed UTC instant across an idempotent reread in a non-UTC timezone', async () => {
    expect(new Date('2026-07-11T00:00:00').getTimezoneOffset()).toBe(180);

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
      created_by: 'postgres-test-user' as UUID,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: 'postgres-test-user',
    });
    const tasks = new TaskRepository(db);
    const task = await tasks.create({
      task_id: generateId(),
      session_id: session.session_id,
      created_by: 'postgres-test-user',
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

    const beforeClaim = Date.now();
    const first = await tasks.connectExecutor(task.task_id);
    const second = await tasks.connectExecutor(task.task_id);
    const afterClaim = Date.now();

    expect(first?.transitioned).toBe(true);
    expect(second).toEqual({ task: first?.task, transitioned: false });
    expect(first?.task.last_executor_heartbeat_at).toBe(first?.task.executor_connected_at);
    const connectedAt = Date.parse(first!.task.executor_connected_at!);
    expect(connectedAt).toBeGreaterThanOrEqual(beforeClaim);
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
});
