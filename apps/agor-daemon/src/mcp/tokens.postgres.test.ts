import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
} from '@agor/core/db';
import { type SessionID, type TaskID, TaskStatus, type UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
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
  }
);
