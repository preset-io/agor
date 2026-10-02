/**
 * Transport-level checks for the user-scope reads (design §3, commit 1.3):
 * the query validators accept the new keys and cap id lists, and the RBAC
 * find hooks scope every read to what a regular caller can view.
 */
import { createTenantScopedDatabaseProxy, type Database, UsersRepository } from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  branchQueryValidator,
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
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

type Services = {
  sessions: SessionsService;
  branches: BranchesService;
  'branch-counts': BranchCountsService;
};

function buildApp(db: Database) {
  // Standalone SQLite query tests deliberately install no tenant around-hook.
  const scoped = createTenantScopedDatabaseProxy(db, { requireScope: false });
  const app = feathers<Services>();
  app.use('sessions', new SessionsService(scoped, STUB_APP));
  app.use('branches', new BranchesService(scoped, STUB_APP));
  app.use('branch-counts', new BranchCountsService(scoped), { methods: ['find'] });
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
  app.service('branch-counts').hooks({ before: { find: [scopeFindToAccessibleBranchesSql()] } });
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
    await expect(
      app
        .service('branches')
        .find(asViewer({ teammate: true, board_id: fixture.boardIds[0] }) as never)
    ).rejects.toThrow('teammate cannot be combined');

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
    await expect(
      app.service('sessions').find({
        provider: 'rest',
        user: viewer,
        query: { session_id: { $in: tooMany } },
      } as never)
    ).rejects.toThrow(/validation failed/);
    await expect(
      app.service('branches').find({
        provider: 'rest',
        user: viewer,
        query: { branch_id: { $in: tooMany } },
      } as never)
    ).rejects.toThrow(/validation failed/);
  });
});
