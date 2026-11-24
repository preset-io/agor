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
import { createSessionMcpTokenHook } from './session-mcp-token-hook.js';

const JWT_SECRET = 'session-mcp-hook-test-secret';

function makeApp(session: Session) {
  const app = feathers();
  app.set('authentication', { secret: JWT_SECRET });
  app.use('sessions', {
    async get() {
      return { ...session };
    },
  });
  app
    .service('sessions')
    .hooks({ after: { get: [createSessionMcpTokenHook({ app: app as never, config: {} })] } });
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

const member = { user_id: 'test-user', role: 'member' };

function executorParams(session: Session, taskId: string, user = member) {
  return {
    user,
    provider: 'socketio',
    authentication: {
      strategy: 'jwt',
      payload: {
        type: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
        session_id: session.session_id,
        task_id: taskId,
      },
    },
  };
}

async function seedRunningTask(db: Database, session: Session) {
  return new TaskRepository(db).create({
    session_id: session.session_id,
    created_by: 'test-user',
    status: TaskStatus.RUNNING,
    executor_connected_at: new Date().toISOString(),
  });
}

describe('sessions MCP-token after hook', () => {
  dbTest('attaches a task-bound default-static token to a task executor', async ({ db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const session = await seedSession(db);
    const task = await seedRunningTask(db, session);
    // No request tenant params or ambient ALS: this models executor fetches (issue #2003).
    const result = await makeApp(session)
      .service('sessions')
      .get(session.session_id, executorParams(session, task.task_id) as never);

    const claims = jwt.verify((result as Session).mcp_token!, JWT_SECRET) as {
      tid?: string;
      tsk?: string;
    };
    expect(claims).toMatchObject({ tid: 'default', tsk: task.task_id });
  });

  dbTest('returns no token to an internal re-read that carries executor params', async ({ db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const session = await seedSession(db);
    const task = await seedRunningTask(db, session);
    const internal = { ...executorParams(session, task.task_id), provider: undefined };

    expect(
      await makeApp(session)
        .service('sessions')
        .get(session.session_id, internal as never)
    ).not.toHaveProperty('mcp_token');
  });

  dbTest("returns no token for a session other than the executor's own", async ({ db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const own = await seedSession(db);
    const parent = await seedSession(db);
    const task = await seedRunningTask(db, own);

    expect(
      await makeApp(parent)
        .service('sessions')
        .get(parent.session_id, executorParams(own, task.task_id) as never)
    ).not.toHaveProperty('mcp_token');
  });

  dbTest.for([
    ['a browser/API member', { user: member }],
    ['a superadmin', { user: { user_id: 'admin', role: 'superadmin' } }],
    ['the daemon service identity', { user: { user_id: 'executor-service', role: 'service' } }],
    [
      'a taskless command executor',
      {
        user: member,
        authentication: {
          strategy: 'jwt',
          payload: { type: EXECUTOR_SESSION_TOKEN_TYPE, purpose: 'executor-command' },
        },
      },
    ],
  ] as const)('returns no token to %s', async ([, params], { db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const session = await seedSession(db);
    const service = makeApp(session).service('sessions');

    expect(await service.get(session.session_id, params as never)).not.toHaveProperty('mcp_token');
  });

  dbTest('returns no token to a viewer even with task executor scope', async ({ db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const session = await seedSession(db);
    const task = await seedRunningTask(db, session);
    const params = executorParams(session, task.task_id, { user_id: 'v', role: 'viewer' });

    expect(
      await makeApp(session)
        .service('sessions')
        .get(session.session_id, params as never)
    ).not.toHaveProperty('mcp_token');
  });

  dbTest('/mcp refuses a task executor token once its task ends', async ({ db }) => {
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const session = await seedSession(db);
    const task = await seedRunningTask(db, session);
    const app = makeApp(session);
    const executorToken = (
      (await app
        .service('sessions')
        .get(session.session_id, executorParams(session, task.task_id) as never)) as Session
    ).mcp_token!;

    const web = express();
    web.use(express.json());
    web.set('authentication', { secret: JWT_SECRET });
    Object.assign(web, {
      service: (name: string) =>
        name === 'users'
          ? { get: async () => ({ ...member, email: 'u@example.com' }) }
          : app.service(name),
    });
    setupMCPRoutes(web as never, db, false);
    const server = web.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as { port: number };
      const listTools = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${executorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        await response.text();
        return response.status;
      };

      expect(await listTools()).toBe(200);
      await new TaskRepository(db).update(task.task_id, { status: TaskStatus.COMPLETED });
      expect(await listTools()).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
