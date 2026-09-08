import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, UUID } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw, insert } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { branches, sessions } from '../schema';
import * as schema from '../schema.postgres';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BoardRepository } from './boards';
import { visibleBranchAccessCondition } from './branch-access';
import { BranchRepository } from './branches';
import { bindQuery, policyLoops } from './inventory-plan-test-helpers';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { exerciseSessionInventory } from './sessions.inventory-test-helpers';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'session inventory query cardinality (isolated PostgreSQL)',
  () => {
    let db: Database;
    const captured: { query: string; params: unknown[] }[] = [];
    let capture = false;
    beforeAll(async () => {
      const raw = createDatabase({ dialect: 'postgresql', url: url! });
      const client = (raw as unknown as { $client: ReturnType<typeof postgres> }).$client;
      db = drizzle(client, {
        schema,
        logger: {
          logQuery(query, params) {
            if (capture) captured.push({ query, params });
          },
        },
      });
      await initializeDatabase(db);
    });

    it('preserves policy precedence and prevents cross-tenant inventory/count inference', async () => {
      const tenantA = `inventory-a-${generateId()}`;
      const tenantB = `inventory-b-${generateId()}`;
      const foreign = await runWithTenantDatabaseScope(db, tenantB, exerciseSessionInventory);
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const local = await exerciseSessionInventory(scoped);
        const repository = new SessionRepository(scoped);
        for (const visibleToUserId of [undefined, local.owner, local.viewer]) {
          expect(
            await repository.findPage({ visibleToUserId, branchId: foreign.branchId, limit: 1 })
          ).toEqual({ total: 0, data: [] });
          expect(
            await repository.findPage({ visibleToUserId, boardId: foreign.boardId, limit: 0 })
          ).toEqual({ total: 0, data: [] });
          expect(await repository.findAll({ visibleToUserId, branchId: foreign.branchId })).toEqual(
            []
          );
          expect(await repository.findByBoard(foreign.boardId, { visibleToUserId })).toEqual([]);
          const taskRepo = new TaskRepository(scoped);
          const messageRepo = new MessagesRepository(scoped);
          for (const childRepo of [taskRepo, messageRepo]) {
            expect(
              await childRepo.findAll({ visibleToUserId, sessionId: foreign.sessionId })
            ).toEqual([]);
            expect(
              await childRepo.findPage({ visibleToUserId, sessionId: foreign.sessionId, limit: 1 })
            ).toEqual({ total: 0, data: [] });
            expect(
              await childRepo.findPage({ visibleToUserId, taskId: foreign.childTaskId, limit: 0 })
            ).toEqual({ total: 0, data: [] });
          }
          expect(
            await messageRepo.findPage({
              visibleToUserId,
              messageId: foreign.childMessageId,
              limit: 1,
            })
          ).toEqual({ total: 0, data: [] });
          if (visibleToUserId) {
            expect(
              await repository.findAccessibleSessions(visibleToUserId, foreign.boardId)
            ).toEqual([]);
          }
        }
        for (const childRepo of [new TaskRepository(scoped), new MessagesRepository(scoped)]) {
          expect(await childRepo.findPage({ limit: 0 })).toEqual({ total: local.total, data: [] });
        }
        expect((await repository.findPage({ limit: 100 })).total).toBe(local.total);
        expect(
          (await repository.findPage({ limit: 100 })).data.map((s) => s.session_id)
        ).not.toContain(foreign.sessionId);
      });
    }, 30000);
    afterAll(async () => {
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    });

    it('compares session-correlated and branch-set counts under RLS', async () => {
      await runWithTenantDatabaseScope(db, `inventory-${generateId()}`, async (scoped) => {
        const users = new UsersRepository(scoped);
        const owner = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const viewer = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const board = await new BoardRepository(scoped).create({
          name: 'Inventory',
          created_by: owner.user_id,
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `inventory-${generateId()}`,
          name: 'Inventory',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/inventory.git',
          local_path: '/tmp/inventory',
          default_branch: 'main',
        });
        const branchRepo = new BranchRepository(scoped);
        const branchCount = 200;
        const sessionsPerBranch = 100;
        let visibleBranchId!: BranchID;
        for (let b = 0; b < branchCount; b++) {
          const branch = await branchRepo.create({
            repo_id: repo.repo_id,
            board_id: board.board_id,
            created_by: owner.user_id,
            name: `branch-${b}`,
            ref: `branch-${b}`,
            path: `/tmp/inventory/${b}`,
            branch_unique_id: b,
            permission_binding: 'override',
            others_can: b % 2 ? 'view' : 'none',
          });
          if (b === 1) visibleBranchId = branch.branch_id;
          await insert(scoped, sessions)
            .values(
              Array.from({ length: sessionsPerBranch }, (_, s) => ({
                session_id: generateId(),
                branch_id: branch.branch_id,
                created_by: owner.user_id,
                created_at: new Date(1700000000000 + s),
                updated_at: new Date(1700000000000 + s),
                status: 'idle',
                agentic_tool: 'claude-code',
                archived: false,
                data: {
                  tasks: [],
                  contextFiles: [],
                  genealogy: { children: [] },
                  title: `Session ${s}`,
                },
              }))
            )
            .run();
        }
        await executeRaw(scoped, sql`ANALYZE sessions`);
        await executeRaw(scoped, sql`ANALYZE branches`);
        await executeRaw(scoped, sql`ANALYZE branch_permission_configs`);
        const predicate = visibleBranchAccessCondition(scoped, viewer.user_id as UUID);
        const legacy = sql`SELECT count(*) FROM ${sessions}
          LEFT JOIN ${branches} ON ${sessions.branch_id} = ${branches.branch_id}
          WHERE ${sessions.archived} = false AND ${predicate}`;
        const legacyCount = await executeRaw(scoped, legacy);
        const repository = new SessionRepository(scoped);
        const opts = {
          archived: false,
          visibleToUserId: viewer.user_id as UUID,
          limit: 20,
          sortUpdatedAt: -1 as const,
        };
        captured.length = 0;
        capture = true;
        const page = await repository.findPage(opts);
        capture = false;
        expect(page.total).toBe((branchCount * sessionsPerBranch) / 2);
        expect(Number((legacyCount as { count: string }[])[0].count)).toBe(page.total);
        expect(page.data).toHaveLength(20);
        expect(captured).toHaveLength(2);
        expect(captured[1].query).not.toContain('"branches"."data"');
        const actualQueries = captured.map(({ query, params }) => bindQuery(query, params));
        for (const [name, query] of [
          ['legacy', legacy],
          ['count', actualQueries[0]],
          ['page', actualQueries[1]],
        ] as const) {
          const plan = await executeRaw(
            scoped,
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
          );
          if (name !== 'legacy') {
            const loops = policyLoops(plan);
            expect(loops.length).toBeGreaterThan(0);
            expect(Math.max(...loops)).toBeLessThanOrEqual(branchCount);
          }
          process.stdout.write(
            `INVENTORY_PLAN ${name} branches=${branchCount} sessions=${branchCount * sessionsPerBranch} ${JSON.stringify(plan)}\n`
          );
        }
        // The residual and compatibility inventories must use the same bounded
        // branch-set composition as paging, not re-evaluate policy per Session.
        for (const [name, read, expectedRows, policyBound] of [
          [
            'findAll',
            () => repository.findAll({ visibleToUserId: viewer.user_id }),
            page.total,
            branchCount,
          ],
          [
            'findByBoard',
            () => repository.findByBoard(board.board_id, { visibleToUserId: viewer.user_id }),
            page.total,
            branchCount,
          ],
          [
            'findAccessibleSessions',
            () => repository.findAccessibleSessions(viewer.user_id, board.board_id),
            page.total,
            branchCount,
          ],
          [
            'findAllExactBranch',
            () =>
              repository.findAll({ visibleToUserId: viewer.user_id, branchId: visibleBranchId }),
            sessionsPerBranch,
            1,
          ],
        ] as const) {
          captured.length = 0;
          capture = true;
          const inventory = await read();
          capture = false;
          expect(inventory).toHaveLength(expectedRows);
          expect(captured).toHaveLength(1);
          const plan = await executeRaw(
            scoped,
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${bindQuery(captured[0].query, captured[0].params)}`
          );
          process.stdout.write(
            `INVENTORY_PLAN ${name} branches=${branchCount} sessions=${branchCount * sessionsPerBranch} ${JSON.stringify(plan)}\n`
          );
          const loops = policyLoops(plan);
          // A changed plan/extractor must not silently turn this bound into -Infinity.
          expect(loops.length).toBeGreaterThan(0);
          expect(Math.max(...loops)).toBeLessThanOrEqual(policyBound);
        }
        captured.length = 0;
        capture = true;
        expect(await repository.findPage({ ...opts, limit: 0 })).toEqual({
          total: page.total,
          data: [],
        });
        capture = false;
        expect(captured).toHaveLength(1);
      });
    }, 120000);
  }
);
