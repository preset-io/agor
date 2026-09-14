import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  branches,
  type Database,
  generateId,
  insert,
  RepoRepository,
  sessions,
  shortId,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Session, SessionID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
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
  await insert(db, sessions)
    .values({
      session_id: sessionId,
      created_at: new Date(),
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
    'attaches a default-static token through executor/background Feathers sessions.get',
    async ({ db }) => {
      await expectDefaultStaticToken(db, 'get', {
        user_id: 'executor-service',
        role: 'service',
      });
    }
  );
});
