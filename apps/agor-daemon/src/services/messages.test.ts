import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { type AgorClient, createRestClient } from '@agor/core/api';
import { MESSAGE_PAGINATION } from '@agor/core/config';
import {
  AuthenticationService,
  authenticate,
  errorHandler,
  feathers,
  feathersExpress,
  rest,
} from '@agor/core/feathers';
import {
  messageQueryValidator,
  taskQueryValidator,
  typedValidateQuery,
} from '@agor/core/lib/feathers-validation';
import type { Message, MessageCreate, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole, ROLES } from '@agor/core/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, vi } from 'vitest';
import {
  ReactiveSessionHandle,
  type TaskHydrationMode,
} from '../../../../packages/client/src/reactive-session';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { MessagesRepository } from '../../../../packages/core/src/db/repositories/messages';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { TaskRepository } from '../../../../packages/core/src/db/repositories/tasks';
import { UsersRepository } from '../../../../packages/core/src/db/repositories/users';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy';
import { validateMessageCreate } from '../hooks/validate-message-create';
import {
  resolveSessionContext,
  scopeFindToAccessibleSessionsSql,
} from '../utils/branch-authorization';
import { createMessagesService, MESSAGES_SERVICE_TRANSPORT_METHODS } from './messages';
import { createTasksService } from './tasks';
import { createUsersService } from './users';

const JWT_SECRET = 'messages-rest-test-secret';

async function createTestSession(
  db: Parameters<typeof dbTest>[0]['db'],
  options: { createdBy?: UUID; othersCan?: 'none' | 'view' } = {}
): Promise<SessionID> {
  const createdBy = options.createdBy ?? (generateId() as UUID);
  const users = new UsersRepository(db);
  if (!(await users.findById(createdBy))) {
    await users.create({
      user_id: createdBy,
      email: `${createdBy}@messages.test`,
      role: ROLES.MEMBER,
    });
  }
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
    created_by: createdBy,
    others_can: options.othersCan,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    title: 'Messages service test session',
    created_by: createdBy,
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

async function createMessages(
  repository: MessagesRepository,
  messageList: Message[]
): Promise<Message[]> {
  const created: Message[] = [];
  for (const item of messageList) created.push(await repository.create(item));
  return created;
}

describe('MessagesService.find pagination', () => {
  dbTest(
    'pushes the public page limit into SQL instead of hydrating every match',
    async ({ db }) => {
      const sessionId = await createTestSession(db);
      const repository = new MessagesRepository(db);
      await createMessages(
        repository,
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

      await expect(createMessagesService(db).find({ query: { $skip: 10_001 } })).rejects.toThrow(
        'Deep Message pagination requires an exact task_id or session_id filter'
      );
      await expect(
        createMessagesService(db).find({ query: { session_id: sessionId, $skip: 10_001 } })
      ).resolves.toMatchObject({ total: 32, data: [] });
    }
  );

  dbTest('walks an exact transcript with an immutable Message-ID keyset', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const repository = new MessagesRepository(db);
    const created = await createMessages(repository, [
      message(sessionId, 0),
      message(sessionId, 1),
      message(sessionId, 2),
    ]);
    const ids = created.map((item) => item.message_id).sort();

    const result = await createMessagesService(db).find({
      query: {
        session_id: sessionId,
        message_id: { $gt: ids[0], $lte: ids[2] },
        $sort: { message_id: 1 },
        $limit: 10,
      },
    });
    expect((result as { data: Message[] }).data.map((item) => item.message_id)).toEqual(
      ids.slice(1)
    );
  });

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
    await createMessages(repository, [
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

describe('MessagesService.create boundary', () => {
  dbTest(
    'runs the durable-delivery hook once and rolls back the Message on hook failure',
    async ({ db }) => {
      const sessionId = await createTestSession(db);
      const createdMessage = message(sessionId, 0);
      const onCreateInTransaction = vi.fn(async () => {
        throw new Error('durable delivery insert failed');
      });

      await expect(
        createMessagesService(db, onCreateInTransaction).create(createdMessage)
      ).rejects.toThrow('durable delivery insert failed');

      expect(onCreateInTransaction).toHaveBeenCalledOnce();
      expect(await new MessagesRepository(db).findById(createdMessage.message_id)).toBeNull();
    }
  );

  dbTest('does not duplicate the transaction hook through service create', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const onCreateInTransaction = vi.fn(async () => undefined);

    await createMessagesService(db, onCreateInTransaction).create(message(sessionId, 0));

    expect(onCreateInTransaction).toHaveBeenCalledOnce();
  });

  dbTest('accepts the canonical DTO and generates an omitted message_id', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const { message_id: _messageId, ...input } = message(sessionId, 0);

    const created = await createMessagesService(db).create(input);

    expect(created).toMatchObject(input);
    expect(Array.isArray(created) ? undefined : created.message_id).toEqual(expect.any(String));
  });

  dbTest(
    'rejects missing, malformed, and unsupported create fields with BadRequest',
    async ({ db }) => {
      const sessionId = await createTestSession(db);
      const valid = message(sessionId, 0);
      const cases: Array<[unknown, string]> = [
        [{ ...valid, session_id: undefined }, 'session_id must be a canonical full UUID'],
        [
          { ...valid, message_id: 'not-a-uuid' },
          'message_id must be a canonical full UUID when provided',
        ],
        [
          { ...valid, message_id: `${generateId()}-overlength` },
          'message_id must be a canonical full UUID when provided',
        ],
        [
          { ...valid, task_id: 'task-short' },
          'task_id must be a canonical full UUID when provided',
        ],
        [{ ...valid, role: 'observer' }, 'Unsupported Message role'],
        [{ ...valid, index: -1 }, 'index must be a non-negative integer'],
        [{ ...valid, timestamp: 'not-a-date' }, 'timestamp must be a valid date string'],
        [
          Object.fromEntries(Object.entries(valid).filter(([field]) => field !== 'content')),
          'content must be a string, content-block array, or request object',
        ],
        [{ ...valid, arbitrary: true }, 'Unsupported Message create fields: arbitrary'],
      ];

      for (const [input, error] of cases) {
        await expect(
          createMessagesService(db).create(input as MessageCreate)
        ).rejects.toMatchObject({ code: 400, message: error });
      }
      await expect(new MessagesRepository(db).findBySessionId(sessionId)).resolves.toEqual([]);
    }
  );

  dbTest('rejects arrays on ordinary CRUD', async ({ db }) => {
    const sessionId = await createTestSession(db);
    await expect(
      createMessagesService(db).create([message(sessionId, 0), message(sessionId, 1)])
    ).rejects.toThrow('Bulk Message create is not supported');
    await expect(new MessagesRepository(db).findBySessionId(sessionId)).resolves.toEqual([]);
  });

  dbTest('rejects arrays before branch RBAC tries to resolve a Session', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const app = feathers();
    app.use('messages', createMessagesService(db), {
      methods: [...MESSAGES_SERVICE_TRANSPORT_METHODS],
    });
    app.service('messages').hooks({
      before: {
        // This is the ordering used when branch RBAC is enabled. Without the
        // first hook, resolveSessionContext sees an array and reports a 500.
        create: [validateMessageCreate, resolveSessionContext()],
      },
    });

    await expect(
      app.service('messages').create([message(sessionId, 0), message(sessionId, 1)], {
        provider: 'rest',
      })
    ).rejects.toMatchObject({
      code: 400,
      message: 'Bulk Message create is not supported',
    });
    await expect(new MessagesRepository(db).findBySessionId(sessionId)).resolves.toEqual([]);
  });
});

describe('MessagesService.patch boundary', () => {
  dbTest('keeps identity, ownership, and order immutable', async ({ db }) => {
    const firstSessionId = await createTestSession(db);
    const secondSessionId = await createTestSession(db);
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
      service.patch(created.message_id, { task_id: generateId() as TaskID } as never)
    ).rejects.toThrow('Message fields are immutable: task_id');
  });

  dbTest('rejects a cross-Session Task link during create', async ({ db }) => {
    const firstSessionId = await createTestSession(db);
    const secondSessionId = await createTestSession(db);
    const secondTask = await new TaskRepository(db).create({
      session_id: secondSessionId,
      full_prompt: 'second task',
      created_by: generateId() as UUID,
    });

    await expect(
      createMessagesService(db).create(
        message(firstSessionId, 0, { task_id: secondTask.task_id as TaskID })
      )
    ).rejects.toThrow('task_id must belong to the Message Session');
  });
});

dbTest(
  'parses authenticated REST role filters and scopes inaccessible sessions',
  async ({ db }) => {
    const usersService = createUsersService(db);
    const bearer = await usersService.create({
      email: 'messages-rest-bearer@example.test',
      password: 'test-password-1234',
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

    const accessibleTask = await new TaskRepository(db).create({
      session_id: accessibleSessionId,
      created_by: ownerId,
      full_prompt: 'Synthetic',
      status: 'completed',
    });
    const hiddenTask = await new TaskRepository(db).create({
      session_id: inaccessibleSessionId,
      created_by: ownerId,
      full_prompt: 'Synthetic',
      status: 'completed',
    });
    await createMessages(repository, [
      message(accessibleSessionId, 0, { role: MessageRole.USER, type: 'user' }),
      {
        ...message(accessibleSessionId, 1, { task_id: accessibleTask.task_id }),
        content: [
          { type: 'text', text: 'Visible answer' },
          { type: 'tool_use', id: 'call', name: 'Read', input: { value: 'HTTP_TOOL_CANARY' } },
        ],
        tool_uses: [{ id: 'call', name: 'Read', input: { value: 'HTTP_TOOL_CANARY' } }],
      },
      message(accessibleSessionId, 2),
      message(accessibleSessionId, 3, { role: MessageRole.USER, type: 'user' }),
      message(inaccessibleSessionId, 0, { task_id: hiddenTask.task_id }),
    ]);

    const createdAtSortSessionId = await createTestSession(db, {
      createdBy: ownerId,
      othersCan: 'view',
    });
    const createdAtSortMessages = [3, 2, 1, 0].map((index) =>
      message(createdAtSortSessionId, index)
    );
    for (const item of createdAtSortMessages) {
      await repository.create(item);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

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
    authentication.register('jwt', new RuntimeJWTStrategy());
    app.use('/authentication', authentication);
    app.use('/messages', createMessagesService(db), {
      methods: [...MESSAGES_SERVICE_TRANSPORT_METHODS],
    });

    app.service('messages').hooks({
      before: {
        all: [typedValidateQuery(messageQueryValidator), authenticate({ strategies: ['jwt'] })],
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
      const leanUrl = `http://127.0.0.1:${address.port}/messages?session_id=${accessibleSessionId}&transcript=lean`;
      expect((await fetch(leanUrl)).status).toBe(401);
      const leanResponse = await fetch(leanUrl, { headers });
      expect(leanResponse.status).toBe(200);
      const leanBody = await leanResponse.text();
      expect(JSON.parse(leanBody)).toMatchObject({ total: 4 });
      expect(leanBody).not.toContain('HTTP_TOOL_CANARY');
      const detail = await fetch(
        `http://127.0.0.1:${address.port}/messages?task_id=${accessibleTask.task_id}`,
        { headers }
      );
      expect(await detail.text()).toContain('HTTP_TOOL_CANARY');
      for (const projection of ['', '&transcript=lean']) {
        const hiddenDetail = await fetch(
          `http://127.0.0.1:${address.port}/messages?task_id=${hiddenTask.task_id}${projection}`,
          { headers }
        );
        expect(await hiddenDetail.json()).toMatchObject({ data: [], total: 0 });
      }
      const mismatched = await fetch(
        `http://127.0.0.1:${address.port}/messages?task_id=${accessibleTask.task_id}&session_id=${inaccessibleSessionId}&transcript=lean`,
        { headers }
      );
      expect(await mismatched.json()).toMatchObject({ data: [], total: 0 });
      const hiddenLean = await fetch(
        `http://127.0.0.1:${address.port}/messages?session_id=${inaccessibleSessionId}&transcript=lean`,
        { headers }
      );
      expect(hiddenLean.status).toBe(200);
      expect(await hiddenLean.json()).toMatchObject({ total: 0, data: [] });

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
          .reverse()
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

// Synthetic loopback HTTP measurement. Real task/message services and the real
// reactive client; Session/queue/subscription fixtures avoid launching an agent.
// No production database, SDK, provider, compression, or browser heap involved.
dbTest(
  'measures lean bootstrap and explicit expansion over synthetic HTTP',
  async ({ db }) => {
    const app = feathersExpress(feathers());
    app.use(express.json());
    app.configure(rest());
    const sessions = new SessionRepository(db);
    const tasks = new TaskRepository(db);
    const repository = new MessagesRepository(db);
    app.use('/sessions', { get: (id: string) => sessions.findById(id) });
    app.use('/tasks', createTasksService(db, app));
    app.service('tasks').hooks({ before: { all: [typedValidateQuery(taskQueryValidator)] } });
    app.use('/messages', createMessagesService(db));
    app.use('/sessions/:sessionId/tasks/queue', { find: async () => ({ data: [] }) });
    app.use('/session-streams', {
      create: async (data: { session_id: string }) => ({ ...data, subscribed: true }),
      remove: async (id: string) => ({ session_id: id, subscribed: false }),
    });
    app.service('messages').hooks({ before: { all: [typedValidateQuery(messageQueryValidator)] } });
    app.use(errorHandler());
    const server = (await app.listen(0)) as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const nativeFetch = globalThis.fetch;
    const receipts: { bytes: number; path: string; body: string }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const result = await nativeFetch(input, init);
      if (init?.method !== 'DELETE') {
        const body = await result.clone().text();
        receipts.push({
          bytes: Buffer.byteLength(body),
          path: new URL(String(input)).pathname,
          body,
        });
      }
      return result;
    });
    try {
      for (const dataset of ['tool-heavy', 'message-heavy']) {
        const sessionId = await createTestSession(db);
        const owner = (await sessions.findById(sessionId))!.created_by;
        const textBytes = dataset === 'tool-heavy' ? 256 : 16_384;
        const toolBytes = dataset === 'tool-heavy' ? 100_000 : 128;
        let latestTaskId!: TaskID;
        for (let index = 0; index < 100; index++) {
          const task = await tasks.create({
            session_id: sessionId,
            created_by: owner,
            status: 'completed',
            full_prompt: 'u'.repeat(textBytes),
            model: 'synthetic',
            duration_ms: 1000,
          });
          latestTaskId = task.task_id;
          const input = { value: `CANARY${'x'.repeat(toolBytes)}` };
          await createMessages(repository, [
            {
              ...message(sessionId, index * 3, {
                task_id: task.task_id,
                role: MessageRole.USER,
                type: 'user',
              }),
              content: task.full_prompt,
            },
            {
              ...message(sessionId, index * 3 + 1, { task_id: task.task_id }),
              content: [
                { type: 'text', text: 'a'.repeat(textBytes) },
                { type: 'tool_use', id: 'call', name: 'Read', input },
              ],
              tool_uses: [{ id: 'call', name: 'Read', input }],
            },
            {
              ...message(sessionId, index * 3 + 2, {
                task_id: task.task_id,
                role: MessageRole.USER,
                type: 'user',
              }),
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call',
                  content: `CANARY${'y'.repeat(toolBytes)}`,
                },
                { type: 'text', text: 'b'.repeat(textBytes) },
              ],
            },
          ]);
        }
        const measure = async (mode: TaskHydrationMode) => {
          const client = await createRestClient(base);
          client.io = Object.assign(new EventEmitter(), {
            connected: true,
          }) as unknown as AgorClient['io'];
          const start = receipts.length;
          const handle = new ReactiveSessionHandle(client, sessionId, { taskHydration: mode });
          await handle.ready();
          expect(handle.state.error).toBeNull();
          const initial = receipts.slice(start);
          const metadataSummaryBytes = Buffer.byteLength(
            JSON.stringify(
              handle.state.tasks.map((task) => ({
                model: task.model,
                duration_ms: task.duration_ms,
                created_at: task.created_at,
                created_by: task.created_by,
                normalized_sdk_response: task.normalized_sdk_response,
              }))
            )
          );
          if (mode === 'lean') {
            expect(initial.some((receipt) => receipt.body.includes('CANARY'))).toBe(false);
            expect(handle.state.tasks).toHaveLength(10);
          }
          const detailStart = receipts.length;
          if (mode === 'lean') await handle.loadTaskMessages(latestTaskId);
          const expanded = receipts.slice(detailStart);
          if (mode === 'lean')
            expect(expanded.some((receipt) => receipt.body.includes('CANARY'))).toBe(true);
          handle.dispose();
          return {
            mode,
            metadataSummaryBytes,
            requests: initial.length,
            responseBytes: initial.reduce((n, receipt) => n + receipt.bytes, 0),
            taskResponseBytes: initial
              .filter((receipt) => receipt.path === '/tasks')
              .reduce((n, receipt) => n + receipt.bytes, 0),
            expansionRequests: expanded.length,
            expansionBytes: expanded.reduce((n, receipt) => n + receipt.bytes, 0),
          };
        };
        const baseline = await measure('lazy');
        const lean = await measure('lean');
        console.info(
          'LEAN_POC_HTTP',
          JSON.stringify({
            dataset,
            tasks: 100,
            messages: 300,
            textBytes,
            toolBytes,
            baseline,
            lean,
          })
        );
      }
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
  120_000
);
