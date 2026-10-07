/**
 * Tests for `SessionsService.find` board_id pushdown (non-RBAC path).
 *
 * A session relates to a board through its branch (session.branch_id →
 * branch.board_id). The `sessions.board_id` column is never populated, so the
 * filter MUST go through the branch join — both in the indexed repository query
 * (`findByBoard`) and in the service's non-RBAC find override. These tests pin
 * that behaviour down end-to-end against a real database, and confirm the other
 * Feathers query filters (archived, $sort, $limit/$skip) keep working alongside
 * board_id.
 */
import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import { sessionQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { Session, UserID, UUID } from '@agor/core/types';
import { SESSION_LIST_ROW_SHAPE, SessionStatus } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import type { SessionPageOptions } from '../../../../packages/core/src/db/repositories/sessions';
import {
  legacySessionPage,
  seedSessionVisibilityFixture,
} from '../../../../packages/core/src/db/repositories/sessions.visibility-parity-test-helpers';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import { scopeFindToAccessibleSessionsSql } from '../utils/branch-authorization';
import { SessionsService } from './sessions';

// The find() board_id path only touches the session repos built from `db`; the
// stored `app` is never read. A bare cast keeps the harness minimal.
const STUB_APP = {} as unknown as Application;
afterEach(() => vi.restoreAllMocks());

function createService(db: Database) {
  // Standalone SQLite query tests deliberately install no tenant around-hook.
  return new SessionsService(
    createTenantScopedDatabaseProxy(db, { requireScope: false }),
    STUB_APP
  );
}

async function createBoard(db: any): Promise<UUID> {
  const boardRepo = new BoardRepository(db);
  const board = await boardRepo.create({ name: 'Board', created_by: 'test-user' as UUID });
  return board.board_id as UUID;
}

async function createBranchOnBoard(
  db: any,
  boardId: UUID | null,
  createdBy = 'test-user' as UUID
): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: createdBy,
    ...(boardId ? { board_id: boardId } : {}),
  });
  return branch.branch_id as UUID;
}

async function createSession(
  db: any,
  branchId: UUID,
  overrides: Partial<Session> = {}
): Promise<UUID> {
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UUID,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
  return session.session_id as UUID;
}

function ids(result: Awaited<ReturnType<SessionsService['find']>>): string[] {
  const data = Array.isArray(result) ? result : result.data;
  return data.map((s) => s.session_id).sort();
}

// Like `ids` but preserves result order — for asserting $sort behaviour.
function orderedIds(result: Awaited<ReturnType<SessionsService['find']>>): string[] {
  const data = Array.isArray(result) ? result : result.data;
  return data.map((s) => s.session_id);
}

describe('SessionsService.find — board_id pushdown', () => {
  dbTest(
    'preserves no-count through transport validation and SQL authorization hooks',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        user_id: generateId(),
        email: `count-${generateId()}@example.invalid`,
        role: 'member',
      });
      const visibleBranch = await createBranchOnBoard(db, null, user.user_id);
      const hiddenBranch = await createBranchOnBoard(db, null);
      const visibleIds = [
        await createSession(db, visibleBranch),
        await createSession(db, visibleBranch),
      ];
      await createSession(db, hiddenBranch);
      const app = feathers<{ sessions: SessionsService }>();
      app.use('sessions', createService(db));
      app.service('sessions').hooks({
        before: {
          all: [typedValidateQuery(sessionQueryValidator)],
          find: [scopeFindToAccessibleSessionsSql()],
        },
      });
      for (const provider of ['socketio', 'rest']) {
        const params = { provider, user, query: { $limit: 1, $sort: { updated_at: -1 } } };
        const counted = await app.service('sessions').find(params);
        expect(Array.isArray(counted)).toBe(false);
        if (Array.isArray(counted)) throw new Error('Expected default pagination');
        expect(counted.total).toBe(2);
        expect(visibleIds).toContain(counted.data[0].session_id);
        const spy = vi.spyOn(db, 'select');
        try {
          const uncounted = await app.service('sessions').find({
            ...params,
            query: {
              ...params.query,
              $count: provider === 'rest' ? 'false' : false,
            },
          });
          expect(uncounted).toEqual(counted.data);
          expect(spy.mock.calls.some(([columns]) => columns && 'count' in columns)).toBe(false);
          expect(
            await app.service('sessions').find({
              ...params,
              query: {
                ...params.query,
                branch_id: hiddenBranch,
                $count: false,
              },
            })
          ).toEqual([]);
        } finally {
          spy.mockRestore();
        }
      }
    }
  );

  dbTest(
    'serves a regular user created_by query on the SQL path, recency-sorted and RBAC-scoped',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        user_id: generateId(),
        email: `mine-${generateId()}@example.invalid`,
        role: 'member',
      });
      const visibleBranch = await createBranchOnBoard(db, null, user.user_id);
      const hiddenBranch = await createBranchOnBoard(db, null);
      const older = await createSession(db, visibleBranch, { created_by: user.user_id });
      await createSession(db, visibleBranch); // someone else's session on my branch
      // My session on a branch I can no longer see stays hidden: a filter, not a grant.
      await createSession(db, hiddenBranch, { created_by: user.user_id });
      const newer = await createSession(db, visibleBranch, { created_by: user.user_id });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await new SessionRepository(db).update(older, { title: 'touched' });
      const app = feathers<{ sessions: SessionsService }>();
      app.use('sessions', createService(db));
      app.service('sessions').hooks({
        before: {
          all: [typedValidateQuery(sessionQueryValidator)],
          find: [scopeFindToAccessibleSessionsSql()],
        },
      });
      const findAllSpy = vi.spyOn(SessionRepository.prototype, 'findAll');
      for (const provider of ['socketio', 'rest']) {
        const result = await app.service('sessions').find({
          provider,
          user,
          query: {
            created_by: user.user_id,
            archived: false,
            $sort: { updated_at: -1 },
            $limit: 100,
            $count: provider === 'rest' ? 'false' : false,
          },
        });
        expect(orderedIds(result)).toEqual([older, newer]);
      }
      // The SQL page path never loads the caller's whole visible inventory.
      expect(findAllSpy).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'lets bounded consumers opt out of exact counts without changing default pagination',
    async ({ db }) => {
      const service = createService(db);
      const board = await createBoard(db);
      const branch = await createBranchOnBoard(db, board);
      await createSession(db, branch);
      await createSession(db, branch);
      const query = { board_id: board, $limit: 1, $skip: 1, $sort: { updated_at: -1 } };
      const counted = await service.find({ query });
      expect(Array.isArray(counted)).toBe(false);
      const uncounted = await service.find({ query: { ...query, $count: false } });
      expect(uncounted).toEqual(Array.isArray(counted) ? counted : counted.data);
      expect(await service.find({ query: { ...query, $count: false, $limit: 0 } })).toEqual([]);
      await expect(service.find({ query: { ...query, $count: 'false' } })).rejects.toThrow(
        '$count must be a boolean'
      );
      await expect(
        service.find({ query: { ...query, $count: false, $limit: -1 } })
      ).rejects.toThrow('non-negative integer');
      await expect(
        service.find({ query: { ...query, $count: false, $select: ['session_id'] } })
      ).rejects.toThrow('SQL-paginated');
    }
  );

  dbTest('returns only sessions whose branch is on the requested board', async ({ db }) => {
    const service = createService(db);

    const boardA = await createBoard(db);
    const boardB = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);
    const branchB = await createBranchOnBoard(db, boardB);

    const a1 = await createSession(db, branchA);
    const a2 = await createSession(db, branchA);
    const b1 = await createSession(db, branchB);

    const onA = await service.find({ query: { board_id: boardA, $limit: 100 } });
    expect(ids(onA)).toEqual([a1, a2].sort());

    const onB = await service.find({ query: { board_id: boardB, $limit: 100 } });
    expect(ids(onB)).toEqual([b1]);

    // No board filter → every session across boards.
    const all = await service.find({ query: { $limit: 100 } });
    expect(ids(all)).toEqual([a1, a2, b1].sort());
  });

  dbTest('returns empty for a board with no branches/sessions', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const emptyBoard = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);
    await createSession(db, branchA);

    const result = await service.find({ query: { board_id: emptyBoard, $limit: 100 } });
    expect(ids(result)).toEqual([]);
  });

  dbTest('keeps other filters working alongside board_id', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const active = await createSession(db, branchA, { status: SessionStatus.IDLE });
    await createSession(db, branchA, { archived: true });
    await createSession(db, branchA, { status: SessionStatus.RUNNING });

    // archived filter narrows within the board scope.
    const activeOnly = await service.find({
      query: { board_id: boardA, archived: false, $limit: 100 },
    });
    const activeData = Array.isArray(activeOnly) ? activeOnly : activeOnly.data;
    expect(activeData.every((s) => !s.archived)).toBe(true);
    expect(activeData.map((s) => s.session_id)).toContain(active);
    expect(activeData).toHaveLength(2);

    // status filter narrows within the board scope.
    const running = await service.find({
      query: { board_id: boardA, status: SessionStatus.RUNNING, $limit: 100 },
    });
    const runningData = Array.isArray(running) ? running : running.data;
    expect(runningData).toHaveLength(1);
    expect(runningData[0].status).toBe(SessionStatus.RUNNING);

    // $limit/$skip pagination still applies on the board-scoped set.
    const paged = await service.find({ query: { board_id: boardA, $limit: 1, $skip: 1 } });
    expect(Array.isArray(paged) ? paged.length : paged.data.length).toBe(1);
    expect(Array.isArray(paged) ? 3 : paged.total).toBe(3);
  });
});

describe('SessionsService.find — recency sort + pagination (SQL pushdown)', () => {
  // oldest → newest by updated_at (driven via `last_updated`, which the repo
  // persists to the `updated_at` column).
  const T_OLD = '2026-01-01T00:00:00.000Z';
  const T_MID = '2026-02-01T00:00:00.000Z';
  const T_NEW = '2026-03-01T00:00:00.000Z';

  dbTest(
    'pages exact status with board/branch intersection in SQL, without materializing candidates',
    async ({ db }) => {
      const service = createService(db);
      const board = await createBoard(db);
      const branch = await createBranchOnBoard(db, board);
      const otherBranch = await createBranchOnBoard(db, await createBoard(db));
      await createSession(db, branch, { status: SessionStatus.IDLE });
      const first = await createSession(db, branch, {
        status: SessionStatus.RUNNING,
        created_at: T_OLD,
      });
      const second = await createSession(db, branch, {
        status: SessionStatus.RUNNING,
        created_at: T_NEW,
      });
      await createSession(db, otherBranch, { status: SessionStatus.RUNNING });
      const fallback = vi
        .spyOn(SessionRepository.prototype, 'findAll')
        .mockRejectedValue(new Error('unbounded fallback'));
      try {
        const query = {
          board_id: board,
          branch_id: branch,
          status: SessionStatus.RUNNING,
          $sort: { created_at: -1 as const },
          $limit: 1,
        };
        const page = await service.find({ query });
        expect(orderedIds(page)).toEqual([second]);
        expect(page).toMatchObject({ total: 2, limit: 1, skip: 0 });
        expect(orderedIds(await service.find({ query: { ...query, $skip: 1 } }))).toEqual([first]);
        expect(
          orderedIds(await service.find({ query: { ...query, branch_id: otherBranch } }))
        ).toEqual([]);
        expect(fallback).not.toHaveBeenCalled();
      } finally {
        fallback.mockRestore();
      }
    }
  );

  dbTest('caps the SQL page limit and preserves count-only requests', async ({ db }) => {
    const service = createService(db);
    const branch = await createBranchOnBoard(db, await createBoard(db));
    await createSession(db, branch);
    await createSession(db, branch);
    const pageSpy = vi.spyOn(SessionRepository.prototype, 'findPage');
    expect(await service.find({ query: { branch_id: branch, $limit: 10000 } })).toMatchObject({
      limit: 10000,
    });
    service.paginate = { default: 100, max: 1000 };
    expect(await service.find({ query: { branch_id: branch } })).toMatchObject({ limit: 100 });
    const capped = await service.find({ query: { branch_id: branch, $limit: 10000 } });
    expect(capped).toMatchObject({ total: 2, limit: 1000 });
    expect(pageSpy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1000 }));
    expect(await service.find({ query: { branch_id: branch, $limit: 0 } })).toMatchObject({
      total: 2,
      limit: 0,
      data: [],
    });
  });

  dbTest('keeps residual operators and field selection before pagination', async ({ db }) => {
    const service = createService(db);
    const board = await createBoard(db);
    const branch = await createBranchOnBoard(db, board);
    await createSession(db, branch, { title: 'excluded', created_at: T_OLD });
    const first = await createSession(db, branch, { title: 'first', created_at: T_MID });
    const second = await createSession(db, branch, { title: 'second', created_at: T_NEW });
    for (const scope of [{ board_id: board }, { branch_id: branch }]) {
      const result = await service.find({
        query: {
          ...scope,
          status: SessionStatus.IDLE,
          session_id: { $in: [first, second] },
          $select: ['title'],
          $sort: { created_at: 1 },
          $limit: 1,
          $skip: 1,
        },
      });
      expect(result).toEqual({ total: 2, limit: 1, skip: 1, data: [{ title: 'second' }] });
    }
  });

  dbTest('orders board-scoped sessions by updated_at desc', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const old = await createSession(db, branchA, { last_updated: T_OLD });
    const mid = await createSession(db, branchA, { last_updated: T_MID });
    const recent = await createSession(db, branchA, { last_updated: T_NEW });

    const result = await service.find({
      query: { board_id: boardA, $sort: { updated_at: -1 }, $limit: 100 },
    });
    // Most-recent first — would be a no-op (insertion order) without SQL sort.
    expect(orderedIds(result)).toEqual([recent, mid, old]);
  });

  dbTest('recency sort composes with $limit/$skip (board-scoped)', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const old = await createSession(db, branchA, { last_updated: T_OLD });
    const mid = await createSession(db, branchA, { last_updated: T_MID });
    const recent = await createSession(db, branchA, { last_updated: T_NEW });

    // The first page is the single most-recent session…
    const page1 = await service.find({
      query: { board_id: boardA, $sort: { updated_at: -1 }, $limit: 1 },
    });
    expect(orderedIds(page1)).toEqual([recent]);
    expect(Array.isArray(page1) ? 3 : page1.total).toBe(3);

    // …and skipping it yields the next two in recency order.
    const page2 = await service.find({
      query: { board_id: boardA, $sort: { updated_at: -1 }, $limit: 2, $skip: 1 },
    });
    expect(orderedIds(page2)).toEqual([mid, old]);
  });

  dbTest('uses the SQL page path for branch created_at pagination', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const first = await createSession(db, branchA, {
      session_id: '00000000-0000-7000-8000-000000000001' as UUID,
      created_at: T_OLD,
    });
    const second = await createSession(db, branchA, {
      session_id: '00000000-0000-7000-8000-000000000002' as UUID,
      created_at: T_MID,
    });
    const third = await createSession(db, branchA, {
      session_id: '00000000-0000-7000-8000-000000000003' as UUID,
      created_at: T_NEW,
    });

    const page = await service.find({
      query: {
        branch_id: branchA,
        $sort: { created_at: 1 },
        $limit: 2,
        $skip: 0,
      },
    });
    const nextPage = await service.find({
      query: {
        branch_id: branchA,
        $sort: { created_at: 1 },
        $limit: 2,
        $skip: 2,
      },
    });

    expect(orderedIds(page)).toEqual([first, second]);
    expect(orderedIds(nextPage)).toEqual([third]);
  });

  dbTest('orders the global recent-N slice by updated_at desc across boards', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const boardB = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);
    const branchB = await createBranchOnBoard(db, boardB);

    await createSession(db, branchA, { last_updated: T_OLD });
    const mid = await createSession(db, branchB, { last_updated: T_MID });
    const recent = await createSession(db, branchA, { last_updated: T_NEW });

    // Bounded recent-N (no board filter) — must be the genuinely most recent.
    const result = await service.find({
      query: { archived: false, $sort: { updated_at: -1 }, $limit: 2 },
    });
    expect(orderedIds(result)).toEqual([recent, mid]);
  });

  dbTest('board_id composes with the $in operator (generic pipeline)', async ({ db }) => {
    const service = createService(db);
    const boardA = await createBoard(db);
    const branchA = await createBranchOnBoard(db, boardA);

    const s1 = await createSession(db, branchA);
    await createSession(db, branchA);
    const s3 = await createSession(db, branchA);

    // board_id + $in routes through the operator-capable fallback (not the
    // strict-equality client paginator), so $in must actually filter.
    const result = await service.find({
      query: { board_id: boardA, session_id: { $in: [s1, s3] }, $limit: 100 },
    });
    expect(ids(result)).toEqual([s1, s3].sort());
  });
});

describe('SessionsService.find — lean list projection', () => {
  const heavyContext = {
    teamName: 'Backend',
    gateway_source: { channel_id: 'c', channel_name: 'n', channel_type: 'slack', thread_id: 't' },
    scheduled_run: { rendered_prompt: 'x'.repeat(2_000) },
    slash_commands: ['/review', '/compact'],
    skills: [{ name: 'skill' }],
  };
  const leanContext = {
    teamName: 'Backend',
    gateway_source: heavyContext.gateway_source,
  };

  function contextsById(result: Awaited<ReturnType<SessionsService['find']>>) {
    const data = Array.isArray(result) ? result : result.data;
    return new Map(data.map((s) => [s.session_id, s.custom_context]));
  }

  function readShapes(result: Awaited<ReturnType<SessionsService['find']>>) {
    const data = Array.isArray(result) ? result : result.data;
    return data.map((s) => (s as { read_shape?: unknown }).read_shape);
  }

  dbTest(
    'omits single-session context through transport validation without widening visibility',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        user_id: generateId(),
        email: `lean-${generateId()}@example.invalid`,
        role: 'member',
      });
      const visibleBranch = await createBranchOnBoard(db, null, user.user_id);
      const hiddenBranch = await createBranchOnBoard(db, null);
      const visible = await createSession(db, visibleBranch, { custom_context: heavyContext });
      const plain = await createSession(db, visibleBranch);
      await createSession(db, hiddenBranch, { custom_context: heavyContext });
      const app = feathers<{ sessions: SessionsService }>();
      app.use('sessions', createService(db));
      app.service('sessions').hooks({
        before: {
          all: [typedValidateQuery(sessionQueryValidator)],
          find: [scopeFindToAccessibleSessionsSql()],
        },
      });

      for (const provider of ['socketio', 'rest']) {
        const query = { archived: false, $limit: 10, $sort: { updated_at: -1 } };
        const full = await app.service('sessions').find({ provider, user, query });
        const lean = await app.service('sessions').find({
          provider,
          user,
          query: { ...query, lean: provider === 'rest' ? 'true' : true },
        });
        expect(ids(lean)).toEqual(ids(full));
        expect(ids(lean)).toEqual([visible, plain].sort());
        expect(contextsById(full).get(visible)).toEqual(heavyContext);
        expect(contextsById(lean).get(visible)).toEqual(leanContext);
        expect(contextsById(lean).get(plain)).toEqual(contextsById(full).get(plain));
        // Every lean row is marked, including one that had nothing to omit;
        // full rows never are.
        expect(readShapes(lean)).toEqual([SESSION_LIST_ROW_SHAPE, SESSION_LIST_ROW_SHAPE]);
        expect(readShapes(full)).toEqual([undefined, undefined]);
      }
    }
  );

  dbTest('composes with created_by and session_id $in on the SQL page path', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      user_id: generateId(),
      email: `lean-scope-${generateId()}@example.invalid`,
      role: 'member',
    });
    const visibleBranch = await createBranchOnBoard(db, null, user.user_id);
    const hiddenBranch = await createBranchOnBoard(db, null);
    const mine = await createSession(db, visibleBranch, {
      created_by: user.user_id,
      custom_context: heavyContext,
    });
    const theirs = await createSession(db, visibleBranch, { custom_context: heavyContext });
    // Mine, but on a branch I can't see: lean never widens visibility.
    const hidden = await createSession(db, hiddenBranch, {
      created_by: user.user_id,
      custom_context: heavyContext,
    });
    const app = feathers<{ sessions: SessionsService }>();
    app.use('sessions', createService(db));
    app.service('sessions').hooks({
      before: {
        all: [typedValidateQuery(sessionQueryValidator)],
        find: [scopeFindToAccessibleSessionsSql()],
      },
    });
    const findAllSpy = vi.spyOn(SessionRepository.prototype, 'findAll');
    const pageSpy = vi.spyOn(SessionRepository.prototype, 'findPage');
    try {
      for (const provider of ['socketio', 'rest']) {
        const lean = provider === 'rest' ? 'true' : true;
        const $count = provider === 'rest' ? 'false' : false;
        const byCreator = await app.service('sessions').find({
          provider,
          user,
          query: {
            created_by: user.user_id,
            archived: false,
            $sort: { updated_at: -1 },
            $limit: 200,
            $count,
            lean,
          },
        });
        expect(ids(byCreator)).toEqual([mine]);
        expect(contextsById(byCreator).get(mine)).toEqual(leanContext);

        const byIds = await app.service('sessions').find({
          provider,
          user,
          query: { session_id: { $in: [mine, theirs, hidden] }, $count, lean },
        });
        expect(ids(byIds)).toEqual([mine, theirs].sort());
        for (const context of contextsById(byIds).values()) {
          expect(context).toEqual(leanContext);
        }
      }
      expect(pageSpy).toHaveBeenCalledTimes(4);
      expect(findAllSpy).not.toHaveBeenCalled();
    } finally {
      findAllSpy.mockRestore();
      pageSpy.mockRestore();
    }
  });

  // The repository matrix (`sessions.visibility-parity`) compares every shape
  // with the oracle; this layer checks what transport adds: each principal's
  // hook scoping (superadmin and service-account bypass) and lean rows.
  dbTest(
    'created_by and session_id $in reads match the branch-set form for every principal, lean or full',
    async ({ db }) => {
      const fixture = await seedSessionVisibilityFixture(db);
      const app = feathers<{ sessions: SessionsService }>();
      app.use('sessions', createService(db));
      app.service('sessions').hooks({
        before: {
          all: [typedValidateQuery(sessionQueryValidator)],
          find: [scopeFindToAccessibleSessionsSql()],
        },
      });
      const usersRepo = new UsersRepository(db);
      const principals: { name: string; user: object; visibleToUserId?: UUID }[] = [];
      for (const [name, userId] of Object.entries(fixture.users)) {
        const user = await usersRepo.findById(userId);
        if (!user) throw new Error(`Missing fixture user ${name}`);
        // Superadmins bypass at the hook; the repository then runs unscoped.
        principals.push({
          name,
          user,
          visibleToUserId: user.role === 'superadmin' ? undefined : (userId as UUID),
        });
      }
      principals.push({
        name: 'service-account',
        user: { user_id: fixture.users.outsider, role: 'member', _isServiceAccount: true },
      });
      const mixed = [
        ...fixture.sessionIds.filter((_, index) => index % 3 === 0),
        ...fixture.deletedSessionIds.slice(0, 1),
      ];
      for (const principal of principals) {
        const self = (principal.user as { user_id: UserID }).user_id;
        const cases: [Record<string, unknown>, SessionPageOptions][] = [
          [
            {
              created_by: self,
              archived: false,
              $sort: { updated_at: -1 },
              $limit: 200,
              $count: false,
            },
            {
              createdBy: self,
              archived: false,
              sortUpdatedAt: -1,
              limit: 200,
              includeTotal: false,
            },
          ],
          [
            { session_id: { $in: mixed }, $limit: 100 },
            { sessionIds: mixed, limit: 100 },
          ],
        ];
        for (const [query, opts] of cases) {
          const label = `${principal.name} ${JSON.stringify(opts)}`;
          const params = { provider: 'socketio', user: principal.user };
          const full = await app.service('sessions').find({ ...params, query });
          const lean = await app
            .service('sessions')
            .find({ ...params, query: { ...query, lean: true } });
          const legacy = await legacySessionPage(db, {
            ...opts,
            visibleToUserId: principal.visibleToUserId,
          });
          expect(orderedIds(full), label).toEqual(legacy.rows.map(([id]) => id));
          expect(orderedIds(lean), label).toEqual(orderedIds(full));
          expect(readShapes(lean).every((shape) => shape === SESSION_LIST_ROW_SHAPE)).toBe(true);
          if (legacy.total !== undefined) {
            expect((full as { total: number }).total, label).toBe(legacy.total);
            expect((lean as { total: number }).total, label).toBe(legacy.total);
          }
        }
      }
    },
    60_000
  );

  dbTest('applies to the generic find path and never to get', async ({ db }) => {
    const service = createService(db);
    const board = await createBoard(db);
    const branch = await createBranchOnBoard(db, board);
    const session = await createSession(db, branch, { custom_context: heavyContext });

    // board_id + $in routes through the operator-capable generic pipeline.
    const lean = await service.find({
      query: { board_id: board, session_id: { $in: [session] }, lean: true, $limit: 10 },
    });
    expect(contextsById(lean).get(session)).toEqual(leanContext);
    expect(readShapes(lean)).toEqual([SESSION_LIST_ROW_SHAPE]);
    const notLean = await service.find({ query: { lean: false, $limit: 10 } });
    expect(contextsById(notLean).get(session)).toEqual(heavyContext);
    expect(readShapes(notLean)).toEqual([undefined]);
    const full = await service.get(session);
    expect(full.custom_context).toEqual(heavyContext);
    expect(full).not.toHaveProperty('read_shape');
  });
});

describe('SessionsService writes — read_shape is never writable', () => {
  dbTest('rejects the marker on create, patch, and update and never echoes it', async ({ db }) => {
    const branch = await createBranchOnBoard(db, null);
    const sessionId = await createSession(db, branch, {
      custom_context: { scheduled_run: { schedule_id: 'sched-1' } },
    });
    const app = feathers<{ sessions: SessionsService }>();
    app.use('sessions', createService(db));
    const patched: unknown[] = [];
    app.service('sessions').on('patched', (row: unknown) => patched.push(row));
    const marker = { read_shape: SESSION_LIST_ROW_SHAPE } as unknown as Partial<Session>;

    await expect(
      app.service('sessions').create({ branch_id: branch, ...marker } as never)
    ).rejects.toMatchObject({ code: 400, message: expect.stringMatching(/read_shape/) });
    await expect(
      app.service('sessions').patch(sessionId, { title: 'x', ...marker })
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      app.service('sessions').update(sessionId, { title: 'x', ...marker } as never)
    ).rejects.toMatchObject({ code: 400 });
    expect(patched).toEqual([]);

    const result = await app.service('sessions').patch(sessionId, { title: 'renamed' });
    for (const row of [result, ...patched]) {
      expect(row).not.toHaveProperty('read_shape');
      expect((row as Session).custom_context).toHaveProperty('scheduled_run');
    }
    expect(patched).toHaveLength(1);
  });

  dbTest('the repository drops a marker that reaches it internally', async ({ db }) => {
    const branch = await createBranchOnBoard(db, null);
    const sessionId = await createSession(db, branch);

    const merged = await new SessionRepository(db).update(sessionId, {
      title: 'internal',
      read_shape: SESSION_LIST_ROW_SHAPE,
    } as unknown as Partial<Session>);

    expect(merged.title).toBe('internal');
    expect(merged).not.toHaveProperty('read_shape');
  });
});
