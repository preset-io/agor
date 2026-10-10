/**
 * Transport-level checks for the user-scope reads (design §3, commit 1.3):
 * the query validators accept the new keys and cap id lists, and the RBAC
 * find hooks scope every read to what a regular caller can view.
 */
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  ScheduleRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  branchCountsQueryValidator,
  branchQueryValidator,
  sessionCountsQueryValidator,
  sessionQueryValidator,
  typedValidateQuery,
} from '@agor/core/lib/feathers-validation';
import type { Branch, Session, User } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { exerciseUserScopeReads } from '../../../../packages/core/src/db/repositories/user-scope-reads.test-helpers';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  scopeFindToAccessibleBranchesSql,
  scopeFindToAccessibleSessionsSql,
} from '../utils/branch-authorization';
import { BranchCountsService } from './branch-counts';
import { BranchesService } from './branches';
import { createSessionCountsService } from './session-counts';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

type Services = {
  sessions: SessionsService;
  branches: BranchesService;
  'branch-counts': BranchCountsService;
  'session-counts': ReturnType<typeof createSessionCountsService>;
};

function buildApp(db: Database) {
  // Standalone SQLite query tests deliberately install no tenant around-hook.
  const scoped = createTenantScopedDatabaseProxy(db, { requireScope: false });
  const app = feathers<Services>();
  app.use('sessions', new SessionsService(scoped, STUB_APP));
  app.use('branches', new BranchesService(scoped, STUB_APP));
  app.use('branch-counts', new BranchCountsService(scoped), { methods: ['find'] });
  app.use('session-counts', createSessionCountsService(scoped), { methods: ['find'] });
  app.service('session-counts').hooks({
    before: {
      all: [typedValidateQuery(sessionCountsQueryValidator)],
      find: [scopeFindToAccessibleBranchesSql()],
    },
  });
  app.service('sessions').hooks({
    before: {
      all: [typedValidateQuery(sessionQueryValidator)],
      find: [scopeFindToAccessibleSessionsSql()],
    },
  });
  app.service('branches').hooks({
    before: {
      all: [typedValidateQuery(branchQueryValidator)],
      find: [scopeFindToAccessibleBranchesSql()],
    },
  });
  app.service('branch-counts').hooks({
    before: {
      all: [typedValidateQuery(branchCountsQueryValidator)],
      find: [scopeFindToAccessibleBranchesSql()],
    },
  });
  return app;
}

const rows = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : (result as { data: T[] }).data;

describe('user-scope reads through transport hooks', () => {
  dbTest('scope branch created_by, teammate, $in and counts to the caller', async ({ db }) => {
    const fixture = await exerciseUserScopeReads(db);
    const [publicId, privateId, mateId, privateMateId] = fixture.branchIds;
    const viewer = (await new UsersRepository(db).findById(fixture.viewer)) as User;
    const app = buildApp(db);
    const asViewer = (query: Record<string, unknown>) => ({
      provider: 'rest',
      user: viewer,
      query,
    });

    const mine = rows<Branch>(
      await app
        .service('branches')
        .find(asViewer({ created_by: fixture.owner, archived: 'false' }) as never)
    ).map((b) => b.branch_id);
    expect(mine).toContain(publicId);
    expect(mine).not.toContain(privateId);

    // An enabled schedule alone doesn't make a teammate here: the read
    // returns marker teammates only, the set the client's `isTeammate` sees.
    await new ScheduleRepository(db).create({
      schedule_id: generateId(),
      branch_id: publicId,
      created_by: fixture.owner,
      name: 'Heartbeat',
      cron_expression: '0 * * * *',
      timezone_mode: 'utc',
      prompt: 'Heartbeat',
      agentic_tool_config: { agentic_tool: 'claude-code' },
      enabled: true,
      allow_concurrent_runs: false,
      retention: 5,
    });
    const mates = rows<Branch>(
      await app.service('branches').find(asViewer({ teammate: 'true', archived: false }) as never)
    ).map((b) => b.branch_id);
    expect(mates).toEqual([mateId]);
    expect(mates).not.toContain(privateMateId);

    // A capped page reports the real total (no false "all loaded")…
    const owner = (await new UsersRepository(db).findById(fixture.owner)) as User;
    const capped = (await app.service('branches').find({
      provider: 'rest',
      user: owner,
      query: { teammate: true, archived: false, $limit: 1 },
    } as never)) as { total: number; data: Branch[] };
    expect(capped.data).toHaveLength(1);
    expect(capped.total).toBe(2);
    // …and the next page continues where it stopped.
    const next = (await app.service('branches').find({
      provider: 'rest',
      user: owner,
      query: { teammate: true, archived: false, $limit: 1, $skip: 1 },
    } as never)) as { total: number; data: Branch[] };
    expect(next.total).toBe(2);
    expect(new Set([...capped.data, ...next.data].map((b) => b.branch_id))).toEqual(
      new Set([mateId, privateMateId])
    );
    // An empty page past the end still reports the real total.
    const pastEnd = (await app.service('branches').find({
      provider: 'rest',
      user: owner,
      query: { teammate: true, archived: false, $limit: 5, $skip: 10 },
    } as never)) as { total: number; data: Branch[] };
    expect(pastEnd.data).toEqual([]);
    expect(pastEnd.total).toBe(2);
    // A complete page's total is its row count.
    const complete = (await app.service('branches').find({
      provider: 'rest',
      user: owner,
      query: { teammate: true, archived: false },
    } as never)) as { total: number; data: Branch[] };
    expect(complete.total).toBe(complete.data.length);
    // It composes with the other keys, under the same visibility.
    const onBoard = rows<Branch>(
      await app
        .service('branches')
        .find(asViewer({ teammate: true, board_id: fixture.boardIds[0] }) as never)
    ).map((b) => b.branch_id);
    expect(onBoard).toEqual(mates);

    const byIds = rows<Branch>(
      await app
        .service('branches')
        .find(asViewer({ branch_id: { $in: [publicId, privateId] } }) as never)
    ).map((b) => b.branch_id);
    expect(byIds).toEqual([publicId]);

    const counts = (await app.service('branch-counts').find(asViewer({}) as never)) as Array<{
      board_id: string;
      branch_count: number;
    }>;
    expect(counts).toEqual([{ board_id: fixture.boardIds[0], branch_count: 2 }]);
    // Session counts: only sessions on branches the caller can view.
    const sessionCounted = (
      (await app.service('session-counts').find(asViewer({ group_by: 'branch_id' }) as never)) as {
        id: string;
      }[]
    ).map((row) => row.id);
    expect(sessionCounted).toContain(publicId);
    expect(sessionCounted).not.toContain(privateId);
    await expect(
      app.service('session-counts').find(asViewer({ group_by: 'session_id' }) as never)
    ).rejects.toThrow(/Invalid query: /);
    // A filter the counts don't model is rejected, never ignored.
    await expect(
      app.service('branch-counts').find(asViewer({ board_id: fixture.boardIds[0] }) as never)
    ).rejects.toThrow(/Invalid query: /);
    // So are session and branch filters the services don't model.
    for (const [service, query] of [
      ['sessions', { $or: [{ created_by: fixture.owner }] }],
      ['branches', { $or: [{ board_id: fixture.boardIds[0] }] }],
    ] as const) {
      await expect(app.service(service).find(asViewer(query) as never)).rejects.toThrow(
        /Invalid query: /
      );
    }
  });

  dbTest('serve session_id $in on the SQL path and cap id lists', async ({ db }) => {
    const fixture = await exerciseUserScopeReads(db);
    const viewer = (await new UsersRepository(db).findById(fixture.viewer)) as User;
    const app = buildApp(db);
    for (const provider of ['socketio', 'rest']) {
      const result = await app.service('sessions').find({
        provider,
        user: viewer,
        query: { session_id: { $in: fixture.sessionIds }, archived: false, $count: false },
      } as never);
      expect(rows<Session>(result).map((s) => s.session_id)).toEqual([fixture.sessionIds[0]]);
    }
    const tooMany = Array.from({ length: 201 }, () => fixture.sessionIds[0]);
    // A search runs on the SQL page, for a regular caller and for a superadmin.
    const admin = await new UsersRepository(db).create({
      email: 'admin@example.invalid',
      role: 'superadmin',
    });
    for (const [user, expected] of [
      [viewer, [fixture.titledSessionIds[0]]],
      [admin, fixture.titledSessionIds],
    ] as const) {
      const found = await app.service('sessions').find({
        provider: 'rest',
        user,
        query: { search: 'login FIX', archived: false, $limit: 10, $count: false },
      } as never);
      expect(new Set(rows<Session>(found).map((s) => s.session_id))).toEqual(new Set(expected));
    }
    const branches = rows<Branch>(
      await app.service('branches').find({
        provider: 'rest',
        user: viewer,
        query: { search: 'mate', archived: false },
      } as never)
    ).map((b) => b.branch_id);
    expect(branches).toEqual([fixture.branchIds[2]]);
    // `search` is served only by the SQL pages: a shape they don't model
    // (`$select`) is rejected rather than matched by a second implementation.
    for (const [service, query] of [
      ['sessions', { search: 'login' }],
      ['sessions', { search: 'login', board_id: fixture.boardIds[0] }],
      ['sessions', { search: 'login', branch_id: fixture.branchIds[0] }],
      ['branches', { search: 'mate' }],
      ['branches', { search: 'mate', zone_id: 'zone-1' }],
    ] as const) {
      await expect(
        app.service(service).find({
          provider: 'rest',
          user: viewer,
          query: { ...query, archived: false, $select: ['name'] },
        } as never)
      ).rejects.toThrow(/search is supported only/);
    }
    // Every search shape a caller can send takes the same SQL match, so
    // non-ASCII case folding and legacy teammate keys agree across scopes.
    const owner = (await new UsersRepository(db).findById(fixture.owner)) as User;
    const cafe = await new SessionRepository(db).create({
      branch_id: fixture.branchIds[0],
      created_by: fixture.owner,
      status: 'idle',
      title: 'CAFÉ menu',
    });
    const sessionHits = async (search: string, scope: Record<string, unknown>) =>
      rows<Session>(
        await app.service('sessions').find({
          provider: 'rest',
          user: owner,
          query: { search, archived: false, $count: false, ...scope },
        } as never)
      ).map((s) => s.session_id);
    for (const search of ['menu', 'café', 'CAFÉ']) {
      const unscoped = await sessionHits(search, {});
      if (search === 'menu') expect(unscoped).toEqual([cafe.session_id]);
      for (const scope of [
        { board_id: fixture.boardIds[0] },
        { branch_id: fixture.branchIds[0] },
      ]) {
        expect(await sessionHits(search, scope)).toEqual(unscoped);
      }
    }
    const legacy = await new BranchRepository(db).create({
      repo_id: (await new BranchRepository(db).findById(fixture.branchIds[0]))!.repo_id,
      board_id: fixture.boardIds[0],
      created_by: fixture.owner,
      name: 'helper',
      ref: 'helper',
      path: '/tmp/user-scope/helper',
      branch_unique_id: 7999,
      custom_context: {
        teammate: { kind: 'teammate', displayName: 'Helper' },
        agent: { displayName: 'Legacy Bot' },
      },
    });
    for (const query of [{}, { board_id: fixture.boardIds[0] }, { created_by: fixture.owner }]) {
      const found = rows<Branch>(
        await app.service('branches').find({
          provider: 'rest',
          user: owner,
          query: { search: 'legacy bot', archived: false, ...query },
        } as never)
      ).map((b) => b.branch_id);
      expect(found).toEqual([legacy.branch_id]);
    }
    // NUL ends a SQLite LIKE pattern (`'%\0%'` matches every row): rejected.
    for (const service of ['sessions', 'branches'] as const) {
      await expect(
        app.service(service).find({
          provider: 'rest',
          user: viewer,
          query: { search: '\u0000', archived: false, $limit: 10 },
        } as never)
      ).rejects.toThrow(/Invalid query: /);
    }
    // A search is at most MAX_SEARCH_TOKENS distinct terms; repeats count once.
    const nine = 'a b c d e f g h i';
    for (const service of ['sessions', 'branches'] as const) {
      await expect(
        app.service(service).find({
          provider: 'rest',
          user: viewer,
          query: { search: nine, archived: false, $limit: 10 },
        } as never)
      ).rejects.toMatchObject({ name: 'BadRequest', message: expect.stringMatching(/at most 8/) });
    }
    const repeated = rows<Session>(
      await app.service('sessions').find({
        provider: 'rest',
        user: viewer,
        query: {
          search: Array.from({ length: 40 }, () => 'login').join(' '),
          archived: false,
          $limit: 10,
          $count: false,
        },
      } as never)
    ).map((s) => s.session_id);
    expect(repeated).toEqual([fixture.titledSessionIds[0]]);
    await expect(
      app.service('sessions').find({
        provider: 'rest',
        user: viewer,
        query: { session_id: { $in: tooMany } },
      } as never)
    ).rejects.toThrow(/Invalid query: /);
    await expect(
      app.service('branches').find({
        provider: 'rest',
        user: viewer,
        query: { branch_id: { $in: tooMany } },
      } as never)
    ).rejects.toThrow(/Invalid query: /);
  });
});
