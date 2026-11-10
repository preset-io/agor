import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  branches,
  type Database,
  generateId,
  insert,
  RepoRepository,
  sessions,
  shortId,
  TaskRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { type Session, type SessionID, TaskStatus } from '@agor/core/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token.js';
import { setupMCPRoutes } from '../mcp/server.js';
import { initMcpTokens, shutdownMcpTokens } from '../mcp/tokens.js';
import { createSessionMcpTokenAfterHooks } from './session-mcp-token-hook.js';

const JWT_SECRET = 'session-mcp-hook-test-secret';

function makeApp(session: Session) {
  const app = feathers();
  app.set('authentication', { secret: JWT_SECRET });
  app.use('sessions', {
    async create() {
      return { ...session };
    },
    async get() {
      return { ...session };
    },
  });
  const hooks = createSessionMcpTokenAfterHooks({
    app: app as never,
    config: {},
  });
  app.service('sessions').hooks({
    after: {
      create: [hooks.create],
      get: [hooks.get],
    },
  });
  return app;
}

async function seedSession(db: Database): Promise<Session> {
  const sessionId = generateId() as SessionID;
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `slug-${shortId(sessionId)}`,
    name: 'Hook Test Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/test.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });
  const branchId = generateId();
  await insert(db, branches)
    .values({
      branch_id: branchId,
      repo_id: repo.repo_id,
      created_at: new Date(),
      created_by: 'test-user',
      primary_owner_user_id: 'test-user',
      name: 'main',
      ref: 'main',
      branch_unique_id: 1,
      data: { path: '/tmp/test/wt', git_state: { ref_at_start: 'main' } },
    })
    .run();
  const now = new Date();
  await insert(db, sessions)
    .values({
      session_id: sessionId,
      created_at: now,
      updated_at: now,
      status: 'idle',
      agentic_tool: 'claude-code',
      branch_id: branchId,
      created_by: 'test-user',
      data: { genealogy: { children: [] }, contextFiles: [], tasks: [], git_state: {} },
    })
    .run();

  return {
    session_id: sessionId,
    branch_id: branchId,
    created_by: 'test-user',
    status: 'idle',
    agentic_tool: 'claude-code',
  } as Session;
}

afterEach(() => shutdownMcpTokens());

describe('sessions MCP-token after hook', () => {
  async function expectDefaultStaticToken(
    db: Database,
    method: 'create' | 'get',
    user: { user_id: string; role: string }
  ) {
    initMcpTokens({
      db,
      multiTenancy: resolveMultiTenancyConfig({}),
    });
    const session = await seedSession(db);
    const service = makeApp(session).service('sessions');
    const params = {
      // No provider, request tenant params, or ambient ALS: this models the
      // executor/background fetches that exposed issue #2003.
      user,
    };
    const result =
      method === 'create'
        ? await service.create({}, params as never)
        : await service.get(session.session_id, params as never);

    const token = (result as Session).mcp_token;
    expect(token).toEqual(expect.any(String));
    expect((jwt.verify(token!, JWT_SECRET) as { tid?: string }).tid).toBe('default');
  }

  dbTest('attaches a default-static token through Feathers sessions.create', async ({ db }) => {
    await expectDefaultStaticToken(db, 'create', {
      user_id: 'member-user',
      role: 'member',
    });
  });

  dbTest(
    'binds a task executor token to its task so /mcp refuses it after the task ends',
    async ({ db }) => {
      initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
      const session = await seedSession(db);
      const tasks = new TaskRepository(db);
      const task = await tasks.create({
        session_id: session.session_id,
        created_by: 'test-user',
        status: TaskStatus.RUNNING,
        executor_connected_at: new Date().toISOString(),
      });
      const app = makeApp(session);
      const user = { user_id: 'test-user', role: 'member' };
      const executorParams = {
        user,
        provider: 'socketio',
        authentication: {
          strategy: 'jwt',
          payload: {
            type: EXECUTOR_SESSION_TOKEN_TYPE,
            purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
            session_id: session.session_id,
            task_id: task.task_id,
          },
        },
      };
      const executorToken = (
        (await app.service('sessions').get(session.session_id, executorParams as never)) as Session
      ).mcp_token!;
      const memberToken = (
        (await app.service('sessions').get(session.session_id, { user } as never)) as Session
      ).mcp_token!;
      expect((jwt.decode(executorToken) as { tsk?: string }).tsk).toBe(task.task_id);
      expect((jwt.decode(memberToken) as { tsk?: string }).tsk).toBeUndefined();

      const web = express();
      web.use(express.json());
      web.set('authentication', { secret: JWT_SECRET });
      Object.assign(web, {
        service: (name: string) =>
          name === 'users'
            ? { get: async () => ({ ...user, email: 'u@example.com' }) }
            : app.service(name),
      });
      setupMCPRoutes(web as never, db, false);
      const server = web.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const { port } = server.address() as { port: number };
        const listTools = (token: string) =>
          fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              Accept: 'application/json, text/event-stream',
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }).then(async (response) => {
            await response.text();
            return response.status;
          });

        expect(await listTools(executorToken)).toBe(200);
        await tasks.update(task.task_id, { status: TaskStatus.COMPLETED });
        expect(await listTools(executorToken)).toBe(401);
        // Interactive caller tokens are not task-bound and keep their session-scoped lifetime.
        expect(await listTools(memberToken)).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  dbTest(
    'attaches a default-static token through executor/background Feathers sessions.get',
    async ({ db }) => {
      await expectDefaultStaticToken(db, 'get', {
        user_id: 'executor-service',
        role: 'service',
      });
    }
  );
});
