/**
 * PostgreSQL/RLS proof for runtime recovery and its terminal consequences.
 *
 * Run against a database freshly migrated by its owner, using a non-owner role:
 *   AGOR_TEST_POSTGRES_URL=postgresql://... \
 *   pnpm --filter @agor/core exec vitest run src/db/repositories/task-runtime-recovery.postgres.test.ts
 */

import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { GatewayChannelID, TenantID, ThreadSessionMapID, UUID } from '../../types';
import { TaskStatus } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { RuntimeRecoveryDiscoveryRepository, TaskRepository } from './tasks';
import { ThreadSessionMapRepository } from './thread-session-map';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const postgresAdminUrl = process.env.AGOR_TEST_POSTGRES_ADMIN_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchSequence = Date.now() % 1_000_000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function roleUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

interface TenantRuntimeSeed {
  tenantId: TenantID;
  branchId: UUID;
  sessionId: UUID;
  taskId: UUID;
  channelId: GatewayChannelID;
  mappingId: ThreadSessionMapID;
}

async function seedTenant(
  db: Database,
  tenantId: TenantID,
  options: {
    status?: typeof TaskStatus.RUNNING | typeof TaskStatus.COMPLETED;
    complete?: boolean;
  } = {}
): Promise<TenantRuntimeSeed> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const userId = generateId();
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `runtime-recovery-${tenantId}`,
      name: `Runtime recovery ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/runtime-recovery.git',
      local_path: `/tmp/${tenantId}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `runtime-recovery-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchSequence++,
      path: `/tmp/${tenantId}/branch`,
      created_by: userId,
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: userId,
    });
    const taskRepo = new TaskRepository(scoped);
    const status = options.status ?? TaskStatus.COMPLETED;
    const task = await taskRepo.create({
      task_id: generateId(),
      session_id: session.session_id,
      created_by: userId,
      full_prompt: 'recover terminal consequences',
      status,
      ...(status === TaskStatus.COMPLETED
        ? { completed_at: '2020-01-01T00:00:00.000Z' }
        : { executor_connected_at: '2020-01-01T00:00:00.000Z' }),
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2020-01-01T00:00:00.000Z',
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'runtime-recovery' },
      tool_use_count: 0,
    });
    if (options.complete) await taskRepo.markTerminalConsequencesComplete(task.task_id);
    const channel = await new GatewayChannelRepository(scoped).create({
      id: generateId(),
      created_by: userId,
      name: `Runtime recovery ${tenantId}`,
      channel_type: 'slack',
      target_branch_id: branch.branch_id,
      agor_user_id: userId,
      channel_key: generateId(),
      config: {},
      agentic_config: null,
      enabled: false,
    });
    const mapping = await new ThreadSessionMapRepository(scoped).create({
      id: generateId(),
      channel_id: channel.id,
      thread_id: `thread-${tenantId}`,
      session_id: session.session_id,
      branch_id: branch.branch_id,
      status: 'active',
    });
    return {
      tenantId,
      branchId: branch.branch_id,
      sessionId: session.session_id,
      taskId: task.task_id,
      channelId: channel.id,
      mappingId: mapping.id,
    };
  });
}

describe.skipIf(!postgresUrl || !postgresAdminUrl || !usesPostgresSchema)(
  'runtime recovery PostgreSQL RLS',
  () => {
    let db: Database;
    let ownerDb: Database;
    let admin: ReturnType<typeof postgres>;
    let runtimeRole = '';
    let runtimeRoleCreated = false;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ??= 'runtime-recovery-postgres-test-secret';
      ownerDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(ownerDb);

      runtimeRole = `agor_runtime_recovery_${generateId().replaceAll('-', '').slice(0, 20)}`;
      const password = generateId();
      admin = postgres(postgresAdminUrl!, { max: 1, prepare: false });
      const roleIdentifier = quoteIdentifier(runtimeRole);
      const database = quoteIdentifier(databaseName(postgresUrl!));
      await admin.unsafe(
        `CREATE ROLE ${roleIdentifier} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
      );
      runtimeRoleCreated = true;
      await admin.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${roleIdentifier}`);
      await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
      await admin.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdentifier}`
      );

      db = createDatabase({
        dialect: 'postgresql',
        url: roleUrl(postgresUrl!, runtimeRole, password),
      });
      const roleResult = await executeRaw(
        db,
        sql`SELECT current_user AS current_user,
                 pg_get_userbyid(c.relowner) AS table_owner,
                 r.rolsuper AS role_is_superuser,
                 r.rolbypassrls AS role_bypasses_rls,
                 c.relrowsecurity AS rls_enabled,
                 c.relforcerowsecurity AS rls_forced
          FROM pg_class c
          JOIN pg_roles r ON r.rolname = current_user
          WHERE c.oid = 'tasks'::regclass`
      );
      const role = (Array.isArray(roleResult) ? roleResult[0] : roleResult.rows?.[0]) as
        | {
            current_user?: string;
            table_owner?: string;
            role_is_superuser?: boolean;
            role_bypasses_rls?: boolean;
            rls_enabled?: boolean;
            rls_forced?: boolean;
          }
        | undefined;
      if (!role)
        throw new Error('tasks table is missing; migrate the PostgreSQL test database first');
      if (role.current_user === role.table_owner) {
        throw new Error('AGOR_TEST_POSTGRES_URL must use a role that does not own tasks');
      }
      if (role.role_is_superuser || role.role_bypasses_rls) {
        throw new Error('AGOR_TEST_POSTGRES_URL role must not be superuser or BYPASSRLS');
      }
      if (!role.rls_enabled || !role.rls_forced) {
        throw new Error('tasks must have row-level security enabled and FORCE ROW LEVEL SECURITY');
      }
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (ownerDb)
        await (ownerDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (admin) {
        if (runtimeRoleCreated) {
          const role = quoteIdentifier(runtimeRole);
          await admin.unsafe(`DROP OWNED BY ${role}`);
          await admin.unsafe(`DROP ROLE ${role}`);
        }
        await admin.end();
      }
    });

    it('discovers active and incomplete work only, then preserves tenant isolation', async () => {
      const tenantA = `runtime-a-${generateId()}` as TenantID;
      const tenantB = `runtime-b-${generateId()}` as TenantID;
      const tenantActive = `runtime-active-${generateId()}` as TenantID;
      const tenantComplete = `runtime-complete-${generateId()}` as TenantID;
      const tenantPending = `runtime-pending-${generateId()}` as TenantID;
      const a = await seedTenant(db, tenantA);
      const b = await seedTenant(db, tenantB);
      await seedTenant(db, tenantActive, { status: TaskStatus.RUNNING });
      await seedTenant(db, tenantComplete, { complete: true });
      const pending = await seedTenant(db, tenantPending, { complete: true });
      await runWithTenantDatabaseScope(db, tenantPending, (scoped) =>
        new TaskRepository(scoped).materializeGatewayTerminalDelivery(pending.taskId, {
          mapping_id: pending.mappingId,
          channel_id: pending.channelId,
          thread_id: `thread-${tenantPending}`,
          status: 'pending',
          intended_at: new Date().toISOString(),
        })
      );

      const discovered = await runWithSystemDatabaseScope(
        db,
        'test runtime recovery discovery',
        (systemDb) => new RuntimeRecoveryDiscoveryRepository(systemDb).findRecoveryTenantIds(),
        { capability: 'task_runtime_recovery' }
      );
      expect(discovered).toEqual(
        expect.arrayContaining([tenantA, tenantB, tenantActive, tenantPending])
      );
      expect(discovered).not.toContain(tenantComplete);

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        expect(await tasks.findById(a.taskId)).not.toBeNull();
        expect(await tasks.findById(b.taskId)).toBeNull();

        await expect(
          tasks.createCompletionCallbackOnce(a.taskId, b.sessionId, {
            full_prompt: 'must not cross tenants',
            created_by: generateId(),
            metadata: { is_agor_callback: true },
          })
        ).rejects.toThrow();

        expect(await new GatewayChannelRepository(scoped).findById(b.channelId)).toBeNull();
        expect(await new ThreadSessionMapRepository(scoped).findBySession(b.sessionId)).toBeNull();
        await expect(
          tasks.update(b.taskId, {
            metadata: {
              gateway_terminal_delivery: {
                mapping_id: b.mappingId,
                channel_id: b.channelId,
                thread_id: `thread-${tenantB}`,
                status: 'delivered',
                intended_at: new Date().toISOString(),
                delivered_at: new Date().toISOString(),
              },
            },
          })
        ).rejects.toThrow();
      });

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const task = await new TaskRepository(scoped).findById(b.taskId);
        expect(task?.metadata?.gateway_terminal_delivery).toBeUndefined();
        expect(await new GatewayChannelRepository(scoped).findById(b.channelId)).not.toBeNull();
        expect(
          await new ThreadSessionMapRepository(scoped).findBySession(b.sessionId)
        ).toMatchObject({
          id: b.mappingId,
        });
      });
    });

    it('admits one concurrent claim of the same CREATED Task and launches only the winner', async () => {
      const tenantId = `runtime-same-created-${generateId()}` as TenantID;
      const seeded = await seedTenant(db, tenantId);
      const created = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new TaskRepository(scoped).createPending({
          session_id: seeded.sessionId,
          full_prompt: 'same created task',
          created_by: generateId(),
          status: TaskStatus.CREATED,
        })
      );
      const launch = vi.fn();
      const claim = () =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const result = await new TaskRepository(scoped).claimDispatchAndProjectSession(
            created.task_id,
            TaskStatus.CREATED,
            { status: TaskStatus.DISPATCHING }
          );
          if (result.outcome === 'claimed') launch(result.task.task_id);
          return result;
        });

      const results = await Promise.all([claim(), claim()]);

      expect(results.map((result) => result.outcome).sort()).toEqual([
        'already_claimed',
        'claimed',
      ]);
      expect(launch).toHaveBeenCalledOnce();
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        expect(await new TaskRepository(scoped).findById(created.task_id)).toMatchObject({
          status: TaskStatus.DISPATCHING,
        });
        expect(await new SessionRepository(scoped).findById(seeded.sessionId)).toMatchObject({
          status: 'running',
          ready_for_prompt: false,
          tasks: expect.arrayContaining([created.task_id]),
        });
      });
    });

    it('admits at most one of different concurrent CREATED Tasks and never launches the loser', async () => {
      const tenantId = `runtime-different-created-${generateId()}` as TenantID;
      const seeded = await seedTenant(db, tenantId);
      const [first, second] = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const tasks = new TaskRepository(scoped);
        return Promise.all([
          tasks.createPending({
            session_id: seeded.sessionId,
            full_prompt: 'first created task',
            created_by: generateId(),
            status: TaskStatus.CREATED,
          }),
          tasks.createPending({
            session_id: seeded.sessionId,
            full_prompt: 'second created task',
            created_by: generateId(),
            status: TaskStatus.CREATED,
          }),
        ]);
      });
      const launch = vi.fn();
      const claim = (taskId: string) =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const result = await new TaskRepository(scoped).claimDispatchAndProjectSession(
            taskId,
            TaskStatus.CREATED,
            { status: TaskStatus.DISPATCHING }
          );
          if (result.outcome === 'claimed') launch(result.task.task_id);
          return result;
        });

      const results = await Promise.all([claim(first.task_id), claim(second.task_id)]);

      expect(results.map((result) => result.outcome).sort()).toEqual([
        'claimed',
        'condition_changed',
      ]);
      expect(launch).toHaveBeenCalledOnce();
      const winner = results.find((result) => result.outcome === 'claimed')!.task;
      const loser = results.find((result) => result.outcome === 'condition_changed')!.task;
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        expect(await new TaskRepository(scoped).findById(loser.task_id)).toMatchObject({
          status: TaskStatus.CREATED,
        });
        expect(await new SessionRepository(scoped).findById(seeded.sessionId)).toMatchObject({
          status: 'running',
          ready_for_prompt: false,
          tasks: expect.arrayContaining([winner.task_id]),
        });
      });
    });
  }
);

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'terminal consequence PostgreSQL migration',
  () => {
    it('baselines legacy terminal Tasks in two tenants without weakening FORCE RLS', async () => {
      const client = postgres(postgresUrl!, { max: 1, prepare: false });
      const schema = `terminal_recovery_${generateId().replaceAll('-', '').slice(0, 20)}`;
      const migration = await readFile(
        new URL(
          '../../../drizzle/postgres/0083_terminal_consequence_recovery.sql',
          import.meta.url
        ),
        'utf8'
      );
      const statements = migration
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);

      try {
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
          await tx.unsafe(`
          CREATE TABLE tasks (
            task_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            status text NOT NULL,
            data jsonb NOT NULL DEFAULT '{}'::jsonb
          );
          CREATE TABLE sessions (
            session_id text PRIMARY KEY,
            tenant_id text NOT NULL,
            status text NOT NULL
          );
          INSERT INTO tasks (task_id, tenant_id, status, data) VALUES
            ('task-a', 'tenant-a', 'completed', '{"preserved":"a"}'),
            ('task-b', 'tenant-b', 'failed', '{"preserved":"b"}'),
            ('active-a', 'tenant-a', 'running', '{}');
          ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
          ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
          ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
          ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation_tasks ON tasks
            USING (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
            WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
          CREATE POLICY tenant_isolation_sessions ON sessions
            USING (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
            WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
        `);

          const roleRows = await tx.unsafe<
            {
              current_user: string;
              table_owner: string;
              role_is_superuser: boolean;
              role_bypasses_rls: boolean;
              rls_enabled: boolean;
              rls_forced: boolean;
            }[]
          >(`
          SELECT current_user AS current_user,
                 pg_get_userbyid(c.relowner) AS table_owner,
                 r.rolsuper AS role_is_superuser,
                 r.rolbypassrls AS role_bypasses_rls,
                 c.relrowsecurity AS rls_enabled,
                 c.relforcerowsecurity AS rls_forced
          FROM pg_class c
          JOIN pg_roles r ON r.rolname = current_user
          WHERE c.oid = 'tasks'::regclass
        `);
          expect(roleRows[0]).toMatchObject({
            current_user: expect.any(String),
            table_owner: expect.any(String),
            role_is_superuser: false,
            role_bypasses_rls: false,
            rls_enabled: true,
            rls_forced: true,
          });
          expect(roleRows[0]?.current_user).toBe(roleRows[0]?.table_owner);

          for (const statement of statements) await tx.unsafe(statement);

          const policies = await tx.unsafe<{ policyname: string }[]>(`
          SELECT policyname FROM pg_policies
          WHERE schemaname = '${schema}' AND policyname LIKE 'terminal_consequence_baseline_%'
        `);
          expect(policies).toEqual([]);
          const migrationScope = await tx.unsafe<{ value: string }[]>(
            `SELECT current_setting('agor.migration_scope', true) AS value`
          );
          expect(migrationScope[0]?.value).toBe('');

          await tx.unsafe(`SELECT set_config('agor.tenant_id', 'tenant-a', true)`);
          const tenantA = await tx.unsafe<
            { task_id: string; preserved: string; completed: string | null }[]
          >(`
          SELECT task_id, data ->> 'preserved' AS preserved,
                 data -> 'metadata' ->> 'terminal_consequences_completed_at' AS completed
          FROM tasks ORDER BY task_id
        `);
          expect(tenantA).toEqual([
            { task_id: 'active-a', preserved: null, completed: null },
            { task_id: 'task-a', preserved: 'a', completed: expect.any(String) },
          ]);

          await tx.unsafe(`SELECT set_config('agor.tenant_id', 'tenant-b', true)`);
          const tenantB = await tx.unsafe<
            { task_id: string; preserved: string; completed: string | null }[]
          >(`
          SELECT task_id, data ->> 'preserved' AS preserved,
                 data -> 'metadata' ->> 'terminal_consequences_completed_at' AS completed
          FROM tasks ORDER BY task_id
        `);
          expect(tenantB).toEqual([
            { task_id: 'task-b', preserved: 'b', completed: expect.any(String) },
          ]);
        });
      } finally {
        await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
    });
  }
);
