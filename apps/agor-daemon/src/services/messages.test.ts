import { PAGINATION } from '@agor/core/config';
import type { Message, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { MessagesRepository } from '../../../../packages/core/src/db/repositories/messages';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { TaskRepository } from '../../../../packages/core/src/db/repositories/tasks';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { createMessagesService } from './messages';

async function createTestSession(db: Parameters<typeof dbTest>[0]['db']): Promise<SessionID> {
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
    created_by: generateId() as UUID,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    title: 'Messages service test session',
    created_by: generateId() as UUID,
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
          $limit: PAGINATION.MAX_LIMIT + 1,
          $select: ['message_id', 'role'],
        },
      });
      expect(selected).toMatchObject({ limit: PAGINATION.MAX_LIMIT, total: 32 });
      expect(Object.keys((selected as { data: Message[] }).data[0]).sort()).toEqual([
        'message_id',
        'role',
      ]);
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
