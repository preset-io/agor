import type { Server } from 'node:http';
import { MESSAGE_PAGINATION } from '@agor/core/config';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  feathers,
  feathersExpress,
  rest,
} from '@agor/core/feathers';
import type { Message, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole, ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, vi } from 'vitest';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { MessagesRepository } from '../../../../packages/core/src/db/repositories/messages';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { TaskRepository } from '../../../../packages/core/src/db/repositories/tasks';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { ServiceJWTStrategy } from '../auth/service-jwt-strategy';
import { scopeFindToAccessibleSessionsSql } from '../utils/branch-authorization';
import { createMessagesService, MESSAGES_SERVICE_TRANSPORT_METHODS } from './messages';
import { createUsersService } from './users';

const JWT_SECRET = 'messages-rest-test-secret';

async function createTestSession(
  db: Parameters<typeof dbTest>[0]['db'],
  options: { createdBy?: UUID; othersCan?: 'none' | 'view' } = {}
): Promise<SessionID> {
  const repo = await new RepoRepository(db).create({
    slug: `messages-service-${generateId()}`,
    name: 'Messages service test repo',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/messages.git',
    local_path: `/tmp/messages-service-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `messages-service-${generateId()}`,
    path: `/tmp/messages-service-branch-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    created_by: options.createdBy ?? (generateId() as UUID),
    others_can: options.othersCan,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    title: 'Messages service test session',
    created_by: options.createdBy ?? (generateId() as UUID),
  });
  return session.session_id as SessionID;
}

function message(
  sessionId: SessionID,
  index: number,
  overrides: Partial<Pick<Message, 'task_id' | 'type' | 'role'>> = {}
): Message {
  return {
    message_id: generateId(),
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    content_preview: `assistant-${index}`,
    content: `assistant message ${index}`,
    ...overrides,
  };
}

describe('MessagesService.find pagination', () => {
  dbTest(
    'pushes the public page limit into SQL instead of hydrating every match',
    async ({ db }) => {
      const sessionId = await createTestSession(db);
      const repository = new MessagesRepository(db);
      await repository.createMany(
        Array.from({ length: 32 }, (_, index) => message(sessionId, index))
      );

      const client = (
        db as unknown as {
          $client: { execute: (...args: unknown[]) => Promise<unknown> };
        }
      ).$client;
      const execute = vi.spyOn(client, 'execute');
      const result = await createMessagesService(db).find({
        query: { session_id: sessionId, role: MessageRole.ASSISTANT, $limit: 2, $skip: 7 },
      });

      expect(result).toMatchObject({
        total: 32,
        limit: 2,
        skip: 7,
        data: expect.arrayContaining([
          expect.objectContaining({ index: 7, role: MessageRole.ASSISTANT }),
          expect.objectContaining({ index: 8, role: MessageRole.ASSISTANT }),
        ]),
      });
      expect((result as { data: Message[] }).data).toHaveLength(2);
      expect((result as { data: Message[] }).data.map((message) => message.index)).toEqual([7, 8]);

      const defaultPage = await createMessagesService(db).find({
        query: { session_id: sessionId },
      });
      expect(defaultPage).toMatchObject({
        total: 32,
        limit: MESSAGE_PAGINATION.DEFAULT_LIMIT,
        skip: 0,
      });

      const statements = execute.mock.calls.map(([query]) => JSON.stringify(query));
      expect(
        statements.some((statement) => /messages/i.test(statement) && /limit/i.test(statement))
      ).toBe(true);

      const descending = await createMessagesService(db).find({
        query: {
          session_id: sessionId,
          role: MessageRole.ASSISTANT,
          $sort: { index: -1 },
          $limit: 2,
        },
      });
      expect((descending as { data: Message[] }).data.map((message) => message.index)).toEqual([
        31, 30,
      ]);

      const selected = await createMessagesService(db).find({
        query: {
          session_id: sessionId,
          role: MessageRole.ASSISTANT,
          $limit: MESSAGE_PAGINATION.MAX_LIMIT + 1,
          $select: ['message_id', 'role'],
        },
      });
      expect(selected).toMatchObject({ limit: MESSAGE_PAGINATION.MAX_LIMIT, total: 32 });
      expect(Object.keys((selected as { data: Message[] }).data[0]).sort()).toEqual([
        'message_id',
        'role',
      ]);

      await expect(
        createMessagesService(db).find({
          query: { session: sessionId } as never,
        })
      ).rejects.toThrow('Unsupported messages query field');
      await expect(
        createMessagesService(db).find({
          query: { session_id: sessionId, $sort: { content: 1 } },
        })
      ).rejects.toThrow('Unsupported $sort field');
    }
  );

  dbTest('composes session $in, task, type, and role predicates in SQL', async ({ db }) => {
    const firstSessionId = await createTestSession(db);
    const secondSessionId = await createTestSession(db);
    const task = await new TaskRepository(db).create({
      session_id: firstSessionId,
      full_prompt: 'message pagination task',
      message_range: { start_index: 0, end_index: 10, start_timestamp: new Date().toISOString() },
      created_by: generateId() as UUID,
    });
    const repository = new MessagesRepository(db);
    await repository.createMany([
      message(firstSessionId, 0, { task_id: task.task_id as TaskID }),
      message(firstSessionId, 1, { type: 'user', role: MessageRole.USER }),
      message(secondSessionId, 0),
    ]);

    const result = await createMessagesService(db).find({
      query: {
        session_id: { $in: [firstSessionId, secondSessionId] },
        task_id: task.task_id,
        type: 'assistant',
        role: 'assistant',
        $limit: 10,
      },
    });

    expect(result).toMatchObject({
      total: 1,
      data: [expect.objectContaining({ task_id: task.task_id })],
    });
  });
});

describe('MessagesService.patch boundary', () => {
  dbTest('keeps identity/order immutable and validates one-time Task linkage', async ({ db }) => {
    const firstSessionId = await createTestSession(db);
    const secondSessionId = await createTestSession(db);
    const taskRepository = new TaskRepository(db);
    const firstTask = await taskRepository.create({
      session_id: firstSessionId,
      full_prompt: 'first task',
      created_by: generateId() as UUID,
    });
    const secondTask = await taskRepository.create({
      session_id: secondSessionId,
      full_prompt: 'second task',
      created_by: generateId() as UUID,
    });
    const repository = new MessagesRepository(db);
    const created = await repository.create(message(firstSessionId, 0));
    const service = createMessagesService(db);

    await expect(
      service.patch(created.message_id, { session_id: secondSessionId } as never)
    ).rejects.toThrow('Message fields are immutable: session_id');
    await expect(service.patch(created.message_id, { index: 99 } as never)).rejects.toThrow(
      'Message fields are immutable: index'
    );
    await expect(
      service.patch(created.message_id, { task_id: secondTask.task_id })
    ).rejects.toThrow('task_id must belong to the Message Session');

    const linked = await service.patch(created.message_id, { task_id: firstTask.task_id });
    expect(linked).toMatchObject({
      message_id: created.message_id,
      session_id: firstSessionId,
      task_id: firstTask.task_id,
      index: 0,
    });
    await expect(
      service.patch(created.message_id, { task_id: secondTask.task_id })
    ).rejects.toThrow('Message task_id cannot be reassigned');
  });
});

dbTest(
  'parses authenticated REST role filters and scopes inaccessible sessions',
  async ({ db }) => {
    const usersService = createUsersService(db);
    const bearer = await usersService.create({
      email: 'messages-rest-bearer@example.test',
      password: 'password-123',
      role: ROLES.MEMBER,
    });
    const ownerId = generateId() as UUID;
    const accessibleSessionId = await createTestSession(db, {
      createdBy: ownerId,
      othersCan: 'view',
    });
    const inaccessibleSessionId = await createTestSession(db, {
      createdBy: ownerId,
      othersCan: 'none',
    });
    const repository = new MessagesRepository(db);

    await repository.createMany([
      message(accessibleSessionId, 0, { role: MessageRole.USER, type: 'user' }),
      message(accessibleSessionId, 1),
      message(accessibleSessionId, 2),
      message(accessibleSessionId, 3, { role: MessageRole.USER, type: 'user' }),
      message(inaccessibleSessionId, 0),
    ]);

    const createdAtSortSessionId = await createTestSession(db, {
      createdBy: ownerId,
      othersCan: 'view',
    });
    const createdAtSortMessages = [3, 2, 1, 0].map((index) =>
      message(createdAtSortSessionId, index)
    );
    await repository.createMany(createdAtSortMessages);

    const app = feathersExpress(feathers());
    app.configure(rest());
    app.set('authentication', {
      secret: JWT_SECRET,
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['jwt'],
      jwtOptions: {
        header: { typ: 'access' },
        audience: 'https://agor.dev',
        issuer: 'agor',
        algorithm: 'HS256',
        expiresIn: '15m',
      },
    });
    app.use('/users', usersService);
    const authentication = new AuthenticationService(app);
    authentication.register('jwt', new ServiceJWTStrategy());
    app.use('/authentication', authentication);
    app.use('/messages', createMessagesService(db), {
      methods: [...MESSAGES_SERVICE_TRANSPORT_METHODS],
    });

    app.service('messages').hooks({
      before: {
        all: [authenticate({ strategies: ['jwt'] })],
        find: [scopeFindToAccessibleSessionsSql({ allowSuperadmin: false })],
      },
    });
    app.use(errorHandler());

    const server = (await app.listen(0)) as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    const accessToken = jwt.sign({ sub: bearer.user_id, type: 'access' }, JWT_SECRET, {
      issuer: 'agor',
      audience: 'https://agor.dev',
      expiresIn: '15m',
    });
    const headers = { authorization: `Bearer ${accessToken}` };

    try {
      const accessibleResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&role=assistant&$limit=1`,
        { headers }
      );
      expect(accessibleResponse.status).toBe(200);
      const accessiblePage = (await accessibleResponse.json()) as {
        total: number;
        limit: number;
        skip: number;
        data: Message[];
      };
      expect(accessiblePage).toMatchObject({ total: 2, limit: 1, skip: 0 });
      expect(typeof accessiblePage.total).toBe('number');
      expect(typeof accessiblePage.limit).toBe('number');
      expect(typeof accessiblePage.skip).toBe('number');
      expect(Array.isArray(accessiblePage.data)).toBe(true);
      expect(accessiblePage.data).toHaveLength(1);
      expect(accessiblePage.data.every((item) => item.role === MessageRole.ASSISTANT)).toBe(true);
      expect(accessiblePage.data[0]?.session_id).toBe(accessibleSessionId);

      const descendingResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&role=assistant&$sort[index]=-1&$limit=1&$skip=1`,
        { headers }
      );
      expect(descendingResponse.status).toBe(200);
      const descendingPage = (await descendingResponse.json()) as {
        total: number;
        limit: number;
        skip: number;
        data: Message[];
      };
      expect(descendingPage).toMatchObject({ total: 2, limit: 1, skip: 1 });
      expect(descendingPage.data.map((item) => item.index)).toEqual([1]);
      expect(typeof descendingPage.limit).toBe('number');
      expect(typeof descendingPage.skip).toBe('number');

      const zeroLimitResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&role=assistant&$limit=0`,
        { headers }
      );
      expect(zeroLimitResponse.status).toBe(200);
      await expect(zeroLimitResponse.json()).resolves.toMatchObject({
        total: 2,
        limit: 0,
        skip: 0,
        data: [],
      });

      const overMaxResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&role=assistant&$limit=${MESSAGE_PAGINATION.MAX_LIMIT + 1}`,
        { headers }
      );
      expect(overMaxResponse.status).toBe(200);
      await expect(overMaxResponse.json()).resolves.toMatchObject({
        total: 2,
        limit: MESSAGE_PAGINATION.MAX_LIMIT,
      });

      for (const parameter of ['$limit=-1', '$skip=-1', '$limit=1.5', '$skip=not-a-number']) {
        const invalidResponse = await fetch(
          `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&${parameter}`,
          { headers }
        );
        expect(invalidResponse.status, `${parameter}: ${await invalidResponse.text()}`).toBe(400);
      }

      const invalidSortResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&$sort[index]=0`,
        { headers }
      );
      expect(invalidSortResponse.status).toBe(400);

      const createdAtResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${createdAtSortSessionId}&$sort[created_at]=-1&$limit=2`,
        { headers }
      );
      expect(createdAtResponse.status).toBe(200);
      const createdAtPage = (await createdAtResponse.json()) as {
        total: number;
        limit: number;
        data: Message[];
      };
      expect(createdAtPage).toMatchObject({ total: 4, limit: 2 });
      expect(createdAtPage.data.map((item) => item.message_id)).toEqual(
        [...createdAtSortMessages]
          .sort((left, right) => left.message_id.localeCompare(right.message_id))
          .slice(0, 2)
          .map((item) => item.message_id)
      );

      const inaccessibleResponse = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${inaccessibleSessionId}&role=assistant&$limit=1`,
        { headers }
      );
      expect(inaccessibleResponse.status).toBe(200);
      const inaccessiblePage = (await inaccessibleResponse.json()) as {
        total: number;
        limit: number;
        skip: number;
        data: Message[];
      };
      expect(inaccessiblePage).toMatchObject({ total: 0, limit: 1, skip: 0, data: [] });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
);
