import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  select,
  TaskRepository,
  users,
} from '@agor/core/db';
import { type SessionID, type TaskID, TaskStatus, type UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { fenceRefusedMembership } from '../auth/launch-auth.js';
import {
  initMcpTokens,
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  shutdownMcpTokens,
  validateSessionToken,
} from './tokens.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const SECRET = 'mcp-token-postgres-test-secret';
const app = { settings: { authentication: { secret: SECRET } } } as never;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'task-bound MCP tokens (PostgreSQL/RLS)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    }, 60_000);
    afterEach(() => shutdownMcpTokens());
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    async function seedRunningTask(tenant: string) {
      return runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        const { branch, user } = await seedEnvironmentCommandBranch(scoped);
        const session = await new SessionRepository(scoped).create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
        });
        const task = await new TaskRepository(scoped).create({
          session_id: session.session_id,
          created_by: user.user_id,
          status: TaskStatus.RUNNING,
          executor_connected_at: new Date().toISOString(),
        });
        return { sessionId: session.session_id, taskId: task.task_id, userId: user.user_id };
      });
    }

    function sign(tenant: string, sessionId: SessionID, userId: UserID, taskId: TaskID) {
      const now = Math.floor(Date.now() / 1000);
      return jwt.sign(
        {
          sub: sessionId,
          uid: userId,
          tid: tenant,
          tsk: taskId,
          aud: MCP_TOKEN_AUDIENCE,
          iss: MCP_TOKEN_ISSUER,
          iat: now,
          exp: now + 60,
          jti: generateId(),
        },
        SECRET,
        { algorithm: 'HS256' }
      );
    }

    it('does not accept a live task from another tenant as the binding', async () => {
      initMcpTokens({
        db: createTenantScopedDatabaseProxy(db),
        multiTenancy: resolveMultiTenancyConfig({
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        }),
      });
      const tenantA = `mcp-task-a-${generateId()}`;
      const tenantB = `mcp-task-b-${generateId()}`;
      const a = await seedRunningTask(tenantA);
      const b = await seedRunningTask(tenantB);

      const own = sign(tenantA, a.sessionId, a.userId as UserID, a.taskId);
      expect(await validateSessionToken(app, own)).toMatchObject({ taskId: a.taskId });

      const foreignTask = sign(tenantA, a.sessionId, a.userId as UserID, b.taskId);
      expect(await validateSessionToken(app, foreignTask)).toBeNull();

      // The task lookup itself is tenant-scoped, independent of the session binding.
      const ownedIn = (tenant: string, task: typeof a) =>
        runWithTenantDatabaseScope(db, tenant, (scoped) =>
          new TaskRepository(scoped).isOwnedByLiveExecutor(task.taskId, task.sessionId)
        );
      expect(await ownedIn(tenantB, b)).toBe(true);
      expect(await ownedIn(tenantA, b)).toBe(false);
    });

    const userRowIn = (tenant: string, userId: string) =>
      runWithTenantDatabaseScope(db, tenant, (scoped) =>
        select(scoped).from(users).where(eq(users.user_id, userId)).one()
      );
    const refuseIn = (tenant: string, userId: string, daemonNowMs = Date.now()) =>
      runWithTenantDatabaseTransaction(db, tenant, (scoped) =>
        fenceRefusedMembership(scoped, userId as UserID, daemonNowMs)
      );

    it("keeps a removal marker written in one tenant away from another tenant's user", async () => {
      const tenantA = `mcp-fence-a-${generateId()}`;
      const tenantB = `mcp-fence-b-${generateId()}`;
      const a = await seedRunningTask(tenantA);
      const b = await seedRunningTask(tenantB);

      await refuseIn(tenantA, a.userId);
      // Tenant A's refusal cannot reach tenant B's row even by its id.
      await refuseIn(tenantA, b.userId);

      expect((await userRowIn(tenantA, a.userId))?.data).toHaveProperty(
        'membership_refused_at',
        expect.any(String)
      );
      expect(await userRowIn(tenantB, a.userId)).toBeNull();
      const bRow = await userRowIn(tenantB, b.userId);
      expect(bRow?.data).not.toHaveProperty('membership_refused_at');
      expect(bRow?.credential_generation).toBe(0);
    });

    it('stamps the marker from the database clock that stamps executor connections', async () => {
      const tenant = `mcp-fence-clock-${generateId()}`;
      const { userId, connectedAt } = await runWithTenantDatabaseScope(
        db,
        tenant,
        async (scoped) => {
          const { branch, user } = await seedEnvironmentCommandBranch(scoped);
          const session = await new SessionRepository(scoped).create({
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'claude-code',
          });
          const tasks = new TaskRepository(scoped);
          const task = await tasks.create({
            session_id: session.session_id,
            created_by: user.user_id,
            status: TaskStatus.DISPATCHING,
          });
          const connected = await tasks.connectExecutor(task.task_id);
          return {
            userId: user.user_id,
            connectedAt: Date.parse(connected!.task.executor_connected_at!),
          };
        }
      );
      // A refusing replica whose clock lags the database by a minute.
      const laggingDaemonMs = Date.now() - 60_000;

      await refuseIn(tenant, userId, laggingDaemonMs);

      const row = await userRowIn(tenant, userId);
      const refusedAtMs = Date.parse(
        (row!.data as { membership_refused_at: string }).membership_refused_at
      );
      expect(refusedAtMs).toBeGreaterThanOrEqual(connectedAt);
      // Browser-token invalidation keeps its daemon-clock semantics.
      expect(new Date(row!.tokens_valid_after!).getTime()).toBe(laggingDaemonMs);
    });
  }
);
