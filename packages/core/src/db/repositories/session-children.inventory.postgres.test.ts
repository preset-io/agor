import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { MessageID, SessionID, TaskID } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw, insert } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { branches, branchPermissionConfigs, messages, sessions, tasks } from '../schema';
import * as schema from '../schema.postgres';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { bindQuery, policyLoops } from './inventory-plan-test-helpers';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'message/task inventory query cardinality (isolated PostgreSQL)',
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

    afterAll(async () => {
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    });
    it.each([1, 10, 100])(
      'bounds broad and scoped policy work with %i sessions per branch',
      async (sessionsPerBranch) => {
        await runWithTenantDatabaseScope(db, `children-${generateId()}`, async (scoped) => {
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
            slug: `children-${generateId()}`,
            name: 'Inventory',
            repo_type: 'remote',
            remote_url: 'https://example.invalid/fixture.git',
            local_path: '/tmp/inventory',
            default_branch: 'main',
          });
          const ids: { sessionId: SessionID; taskId: TaskID; messageId: MessageID }[] = [];
          const branchCount = 200;
          const childrenPerSession = 100 / sessionsPerBranch;
          const childrenPerBranch = sessionsPerBranch * childrenPerSession;
          for (let b = 0; b < branchCount; b++) {
            const branch = await new BranchRepository(scoped).create({
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
            const sessionIds = Array.from(
              { length: sessionsPerBranch },
              () => generateId() as SessionID
            );
            await insert(scoped, sessions)
              .values(
                sessionIds.map((session_id) => ({
                  session_id,
                  branch_id: branch.branch_id,
                  created_by: owner.user_id,
                  created_at: new Date(1700000000000),
                  updated_at: new Date(1700000000000),
                  status: 'idle',
                  agentic_tool: 'claude-code',
                  archived: false,
                  data: { tasks: [], contextFiles: [], genealogy: { children: [] } },
                }))
              )
              .run();
            const taskIds = Array.from({ length: childrenPerBranch }, () => generateId() as TaskID);
            const messageIds = Array.from(
              { length: childrenPerBranch },
              () => generateId() as MessageID
            );
            ids.push({ sessionId: sessionIds[0], taskId: taskIds[0], messageId: messageIds[0] });
            await insert(scoped, tasks)
              .values(
                taskIds.map((task_id, index) => ({
                  task_id,
                  session_id: sessionIds[Math.floor(index / childrenPerSession)],
                  created_by: owner.user_id,
                  created_at: new Date(1700000000000),
                  status: 'completed',
                  data: {
                    full_prompt: 'fixture',
                    message_range: {
                      start_index: 0,
                      end_index: 0,
                      start_timestamp: '2023-11-14T22:13:20.000Z',
                    },
                    git_state: { ref_at_start: 'main', sha_at_start: 'fixture' },
                    tool_use_count: 0,
                  },
                }))
              )
              .run();
            await insert(scoped, messages)
              .values(
                messageIds.map((message_id, index) => ({
                  message_id,
                  session_id: sessionIds[Math.floor(index / childrenPerSession)],
                  task_id: taskIds[Math.floor(index / childrenPerSession) * childrenPerSession],
                  created_at: new Date(1700000000000 + index),
                  timestamp: new Date(1700000000000 + index),
                  type: 'user',
                  role: 'user',
                  index,
                  data: { content: 'fixture' },
                }))
              )
              .run();
          }
          for (const table of [sessions, branches, tasks, messages, branchPermissionConfigs])
            await executeRaw(scoped, sql`ANALYZE ${table}`);
          const taskRepo = new TaskRepository(scoped);
          const messageRepo = new MessagesRepository(scoped);
          for (const [name, read, total, bound, queryCount = 2] of [
            [
              'tasksAll',
              async () => {
                const data = await taskRepo.findAll({ visibleToUserId: viewer.user_id });
                return { data, total: data.length };
              },
              10000,
              branchCount,
              1,
            ],
            [
              'messagesAll',
              async () => {
                const data = await messageRepo.findAll({ visibleToUserId: viewer.user_id });
                return { data, total: data.length };
              },
              10000,
              branchCount,
              1,
            ],
            [
              'tasksBroad',
              () =>
                taskRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  limit: 20,
                  selectTaskIdOnly: true,
                }),
              10000,
              branchCount,
            ],
            [
              'messagesBroad',
              () =>
                messageRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  limit: 20,
                  select: ['message_id'],
                }),
              10000,
              branchCount,
            ],
            [
              'tasksSession',
              () =>
                taskRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  sessionId: ids[1].sessionId,
                  limit: 20,
                }),
              childrenPerSession,
              1,
            ],
            [
              'messagesSession',
              () =>
                messageRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  sessionId: ids[1].sessionId,
                  limit: 20,
                }),
              childrenPerSession,
              1,
            ],
            [
              'tasksMixed',
              () =>
                taskRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  sessionIds: [ids[0].sessionId, ids[1].sessionId],
                  limit: 20,
                }),
              childrenPerSession,
              2,
            ],
            [
              'messagesTask',
              () =>
                messageRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  taskId: ids[1].taskId,
                  limit: 20,
                }),
              childrenPerSession,
              1,
            ],
            [
              'tasksExact',
              () =>
                taskRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  taskId: ids[1].taskId,
                  limit: 20,
                }),
              1,
              1,
            ],
            [
              'messagesExact',
              () =>
                messageRepo.findPage({
                  visibleToUserId: viewer.user_id,
                  messageId: ids[1].messageId,
                  limit: 20,
                }),
              1,
              1,
            ],
          ] as const) {
            captured.length = 0;
            capture = true;
            const page = await read();
            capture = false;
            expect(page.total).toBe(total);
            expect(page.data).toHaveLength(queryCount === 1 ? total : Math.min(20, total));
            expect(captured).toHaveLength(queryCount);
            for (const [i, query] of captured.entries()) {
              const plan = await executeRaw(
                scoped,
                sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${bindQuery(query.query, query.params)}`
              );
              process.stdout.write(
                `INVENTORY_PLAN s${sessionsPerBranch}-${name}-${queryCount === 1 ? 'all' : i === 0 ? 'count' : 'page'} branches=${branchCount} sessions=${branchCount * sessionsPerBranch} ${JSON.stringify(plan)}\n`
              );
              const loops = policyLoops(plan);
              // A changed plan/extractor must not silently turn this bound into -Infinity.
              expect(loops.length).toBeGreaterThan(0);
              expect(Math.max(...loops)).toBeLessThanOrEqual(bound);
            }
          }
        });
      },
      180000
    );
  }
);
