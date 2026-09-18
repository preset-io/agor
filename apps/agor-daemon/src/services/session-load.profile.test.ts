import { once } from 'node:events';
import type { Server } from 'node:http';
import { createClient } from '@agor/core/api';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '@agor/core/db';
import { errorHandler, feathers, feathersExpress, rest, socketio } from '@agor/core/feathers';
import type { UserID, UUID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import {
  releaseReactiveSession,
  retainReactiveSession,
} from '../../../../packages/client/src/reactive-session';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { MessagesRepository } from '../../../../packages/core/src/db/repositories/messages';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { TaskRepository } from '../../../../packages/core/src/db/repositories/tasks';
import { dbTest, ensureTestUser } from '../../../../packages/core/src/db/test-helpers';
import { largeSessionFixture } from '../../../../test/fixtures/large-session';
import { createMessagesService } from './messages';
import { createSessionsService } from './sessions';
import { createTasksService } from './tasks';

// Explicit opt-in: disposable DB + loopback WebSocket, never a configured daemon.
// Authentication/RLS are covered by the existing service/Postgres suites;
// this harness isolates query/materialization/serialization/transport cost.
dbTest.skipIf(!process.env.AGOR_PROFILE_SESSION_LOAD)(
  'profiles the existing lazy bootstrap read sequence on fictional history',
  async ({ db }) => {
    const fixture = largeSessionFixture();
    const owner = await ensureTestUser(db, fixture.tasks[0].created_by as UserID);
    const repo = await new RepoRepository(db).create({
      slug: 'fictional/observatory',
      name: 'Fictional observatory',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/observatory.git',
      local_path: '/fictional/repo',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      repo_id: repo.repo_id,
      name: 'fixture',
      path: '/fictional/branch',
      ref: 'fixture',
      branch_unique_id: 1001,
      created_by: owner as UUID,
    });
    await new SessionRepository(db).create({
      session_id: fixture.sessionId,
      branch_id: branch.branch_id,
      created_by: owner as UUID,
      title: 'Fictional observatory',
    });
    const tasks = new TaskRepository(db);
    for (const task of fixture.tasks) await tasks.create(task);
    const messages = new MessagesRepository(db);
    for (const message of fixture.messages) await messages.create(message);

    const app = feathersExpress(feathers());
    const scopedDb = createTenantScopedDatabaseProxy(db);
    app.hooks({
      around: {
        all: [
          async (_context, next) => {
            await runWithTenantDatabaseScope(scopedDb, 'default', async () => next());
          },
        ],
      },
    });
    app.configure(rest());
    app.configure(socketio());
    app.use('sessions', createSessionsService(scopedDb, app));
    app.use('tasks', createTasksService(scopedDb, app));
    app.use('messages', createMessagesService(scopedDb));
    const streamCreate = vi.fn(async () => ({ session_id: fixture.sessionId }));
    app.use('session-streams', {
      create: streamCreate,
      async remove() {
        return {};
      },
    });
    const queuePath = `sessions/${fixture.sessionId}/tasks/queue`;
    app.use(queuePath, {
      async find() {
        const data = await tasks.findQueued(fixture.sessionId);
        return { total: data.length, data };
      },
    });
    app.use(errorHandler());
    const requests: {
      path: string;
      rows: number;
      bytes: number;
      serviceMs: number;
      stringifyMs: number;
      query: unknown;
    }[] = [];
    for (const path of ['sessions', 'tasks', 'messages', queuePath]) {
      app.service(path).hooks({
        around: {
          all: [
            async (context, next) => {
              const start = performance.now();
              await next();
              const serviceMs = performance.now() - start;
              const stringifyStart = performance.now();
              const json = JSON.stringify(context.result);
              const stringifyMs = performance.now() - stringifyStart;
              requests.push({
                path,
                rows: context.result.data?.length ?? 1,
                bytes: Buffer.byteLength(json),
                serviceMs,
                stringifyMs,
                query: context.params.query,
              });
            },
          ],
        },
      });
    }
    const dbClient = (
      db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }
    ).$client;
    const execute = vi.spyOn(dbClient, 'execute');
    const server = (await app.listen({ port: 0, host: '127.0.0.1' })) as Server;
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected disposable TCP server');
    const client = createClient(`http://127.0.0.1:${address.port}`);
    try {
      const connectionStart = performance.now();
      await new Promise<void>((resolve) => client.io.once('connect', () => resolve()));
      const connectMs = performance.now() - connectionStart;
      const messageService = client.service('messages');
      const findMessages = messageService.find.bind(messageService);
      let finalResponseAt = 0;
      let messageRoundtripMs = 0;
      vi.spyOn(messageService, 'find').mockImplementation(async (params) => {
        const start = performance.now();
        const result = await findMessages(params);
        finalResponseAt = performance.now();
        messageRoundtripMs = finalResponseAt - start;
        return result;
      });
      const start = performance.now();
      const handle = retainReactiveSession(client, fixture.sessionId, { taskHydration: 'lazy' });
      const secondConsumer = retainReactiveSession(client, fixture.sessionId, {
        taskHydration: 'lazy',
      });
      expect(secondConsumer).toBe(handle);
      await handle.ready();
      const readyMs = performance.now() - start;
      const finalResponseToReadyMs = performance.now() - finalResponseAt;
      expect(handle.state.error).toBeNull();
      expect(handle.state.tasks).toHaveLength(500);
      expect(handle.state.messagesByTask.get(fixture.tasks.at(-1)!.task_id)).toHaveLength(20);
      expect(handle.state.messagesByTask.size).toBe(1);
      expect(streamCreate).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(4);
      releaseReactiveSession(client, fixture.sessionId, { taskHydration: 'lazy' });
      releaseReactiveSession(client, fixture.sessionId, { taskHydration: 'lazy' });
      console.log(
        'FICTIONAL_SESSION_TRANSPORT_PROFILE',
        JSON.stringify({
          fixtureTasks: fixture.tasks.length,
          fixtureMessages: fixture.messages.length,
          connectMs,
          readyMs,
          messageRoundtripMs,
          finalResponseToReadyMs,
          subscriptions: streamCreate.mock.calls.length,
          requests,
          sqlStatements: execute.mock.calls.map(([query]) =>
            typeof query === 'string' ? query : (query as { sql: string }).sql
          ),
        })
      );
    } finally {
      client.io.close();
      execute.mockRestore();
      await app.teardown();
    }
  },
  120_000
);
