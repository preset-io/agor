import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UUID } from '../../types/id';
import { TaskStatus } from '../../types/task';
import { createDatabase, type Database } from '../client';
import { executeRaw, isPostgresDatabase, runDatabaseTransaction } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl)('TaskRepository PostgreSQL', () => {
  let db: Database;
  const originalTimezone = process.env.TZ;

  beforeAll(async () => {
    if (!usesPostgresSchema) {
      throw new Error('TaskRepository PostgreSQL tests require AGOR_DB_DIALECT=postgresql');
    }
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

  it('rejects gateway renewal and settlement when their lease expires behind a Task row lock', async () => {
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `postgres-gateway-lease-${Date.now()}`,
      name: 'Postgres gateway lease',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/postgres-gateway-lease.git',
      local_path: '/tmp/postgres-gateway-lease',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'postgres-gateway-lease',
      ref: 'main',
      branch_unique_id: Date.now() % 2_000_000_000,
      path: '/tmp/postgres-gateway-lease/branch',
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
      full_prompt: 'postgres gateway lease lock wait',
      status: TaskStatus.COMPLETED,
      completed_at: new Date().toISOString(),
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'postgres-gateway-lease' },
      tool_use_count: 0,
    });
    const pending = {
      mapping_id: generateId(),
      channel_id: generateId(),
      thread_id: 'postgres-row-lock-wait',
      status: 'pending' as const,
      intended_at: new Date().toISOString(),
    };
    await tasks.materializeGatewayTerminalDelivery(task.task_id, pending);

    const rowsOf = (result: Awaited<ReturnType<typeof executeRaw>>): unknown[] =>
      Array.isArray(result) ? result : (result.rows ?? []);
    const waitForRowLock = async (applicationName: string): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const result = await executeRaw(
          db,
          sql`
            SELECT wait_event_type
            FROM pg_stat_activity
            WHERE application_name = ${applicationName}
          `
        );
        if (
          rowsOf(result).some(
            (row) => (row as { wait_event_type?: unknown }).wait_event_type === 'Lock'
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Contender ${applicationName} did not wait on the Task row lock`);
    };

    const behindRowLock = async <T>(
      label: string,
      leaseExpiresAt: string,
      operation: (contender: TaskRepository) => Promise<T>
    ): Promise<T> => {
      const applicationName = `agor_gateway_lease_${label}_${generateId().slice(0, 8)}`;
      const contenderUrl = new URL(postgresUrl!);
      contenderUrl.searchParams.set('application_name', applicationName);
      const contenderDb = createDatabase({ dialect: 'postgresql', url: contenderUrl.toString() });
      let releaseLock!: () => void;
      let rowLocked!: () => void;
      const locked = new Promise<void>((resolve) => (rowLocked = resolve));
      const release = new Promise<void>((resolve) => (releaseLock = resolve));
      const blocker = runDatabaseTransaction(db, async (tx) => {
        await executeRaw(
          tx,
          sql`SELECT task_id FROM tasks WHERE task_id = ${task.task_id} FOR UPDATE`
        );
        rowLocked();
        await release;
      });
      try {
        await locked;
        const result = operation(new TaskRepository(contenderDb));
        await waitForRowLock(applicationName);
        const remainingResult = await executeRaw(
          db,
          sql`SELECT GREATEST(
                0,
                CEIL(EXTRACT(EPOCH FROM (${leaseExpiresAt}::timestamptz - clock_timestamp())) * 1000)
              ) AS remaining_ms`
        );
        const remainingMs = Number(
          (rowsOf(remainingResult)[0] as { remaining_ms?: unknown } | undefined)?.remaining_ms
        );
        expect(remainingMs).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, remainingMs + 100));
        releaseLock();
        await blocker;
        return await result;
      } finally {
        releaseLock?.();
        await blocker.catch(() => undefined);
        await (
          contenderDb as unknown as Database & { $client: { end: () => Promise<void> } }
        ).$client.end();
      }
    };

    const renewalClaim = await tasks.claimGatewayTerminalDelivery(task.task_id, {
      claimToken: 'renew-after-lock-wait',
      leaseDurationMs: 2_000,
    });
    expect(renewalClaim).toMatchObject({ outcome: 'claimed' });
    const renewalExpiry = renewalClaim.task.metadata?.gateway_terminal_delivery;
    if (renewalExpiry?.status !== 'pending' || !renewalExpiry.claim?.lease_expires_at) {
      throw new Error('Gateway renewal test claim did not materialize its lease');
    }
    await expect(
      behindRowLock('renew', renewalExpiry.claim.lease_expires_at, (contender) =>
        contender.renewGatewayTerminalDeliveryClaim(task.task_id, {
          claimToken: 'renew-after-lock-wait',
          leaseDurationMs: 2_000,
        })
      )
    ).resolves.toBeNull();

    const settlementClaim = await tasks.claimGatewayTerminalDelivery(task.task_id, {
      claimToken: 'settle-after-lock-wait',
      leaseDurationMs: 2_000,
    });
    expect(settlementClaim).toMatchObject({ outcome: 'claimed' });
    const settlementExpiry = settlementClaim.task.metadata?.gateway_terminal_delivery;
    if (settlementExpiry?.status !== 'pending' || !settlementExpiry.claim?.lease_expires_at) {
      throw new Error('Gateway settlement test claim did not materialize its lease');
    }
    await expect(
      behindRowLock('settle', settlementExpiry.claim.lease_expires_at, (contender) =>
        contender.settleGatewayTerminalDelivery(
          task.task_id,
          { ...pending, claim_token: 'settle-after-lock-wait' },
          { ...pending, status: 'delivered', delivered_at: new Date().toISOString() }
        )
      )
    ).resolves.toMatchObject({ outcome: 'stale' });
    await expect(tasks.findById(task.task_id)).resolves.toMatchObject({
      metadata: {
        gateway_terminal_delivery: {
          status: 'pending',
          claim: { claim_token: 'settle-after-lock-wait' },
        },
      },
    });
  }, 15_000);
});
