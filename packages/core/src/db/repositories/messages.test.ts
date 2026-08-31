/**
 * MessagesRepository Tests
 *
 * Tests for CRUD operations on conversation messages, range filtering, and
 * JSON data field handling.
 */

import type { Message, MessageID, SessionID, TaskID, UserID, UUID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { JSON_SANITIZER_LIMITS } from '../../utils/sanitize-json';
import { select, update } from '../database-wrapper';
import { messages as messagesTable } from '../schema';
import { ownedDbTest as dbTest, setTestBranchUserRole } from '../test-helpers';
import { BranchRepository } from './branches';
import { MESSAGE_CONTENT_OMITTED, MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

// Counter to ensure unique repo/branch names across tests
let testCounter = 0;

/**
 * Create test message data
 */
function createMessageData(overrides?: {
  message_id?: MessageID;
  session_id?: SessionID;
  task_id?: TaskID;
  type?: Message['type'];
  role?: MessageRole;
  index?: number;
  timestamp?: string;
  content_preview?: string;
  content?: Message['content'];
  tool_uses?: Message['tool_uses'];
  metadata?: Message['metadata'];
}): Message {
  return {
    message_id: (overrides?.message_id ?? generateId()) as MessageID,
    session_id: (overrides?.session_id ?? generateId()) as SessionID,
    task_id: overrides?.task_id,
    type: overrides?.type ?? 'user',
    role: overrides?.role ?? MessageRole.USER,
    index: overrides?.index ?? 0,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    content_preview: overrides?.content_preview ?? 'Test message',
    content: overrides?.content ?? 'Test message content',
    tool_uses: overrides?.tool_uses,
    metadata: overrides?.metadata,
  };
}

async function createMessages(
  repository: MessagesRepository,
  messageList: Message[]
): Promise<Message[]> {
  const created: Message[] = [];
  for (const message of messageList) created.push(await repository.create(message));
  return created;
}

/**
 * Create a test session (required FK for messages)
 */
async function createTestSession(
  db: any,
  overrides?: { session_id?: UUID; branch_id?: UUID }
): Promise<SessionID> {
  const sessionRepo = new SessionRepository(db);
  const branchRepo = new BranchRepository(db);
  const repoRepo = new RepoRepository(db);

  // Generate unique identifiers to avoid conflicts across tests
  const uniqueId = testCounter++;

  // Create repo first
  const repo = await repoRepo.create({
    slug: `test-repo-${uniqueId}`,
    name: `Test Repo ${uniqueId}`,
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/test-repo-${uniqueId}`,
    default_branch: 'main',
  });

  // Create branch
  const branch = await branchRepo.create({
    branch_id: overrides?.branch_id,
    repo_id: repo.repo_id,
    name: `test-branch-${uniqueId}`,
    path: `/test/branch/${uniqueId}`,
    ref: 'main',
    branch_unique_id: uniqueId,
    created_by: 'test-user' as UUID,
  });

  // Create session
  const session = await sessionRepo.create({
    session_id: overrides?.session_id,
    branch_id: branch.branch_id,
    title: 'Test Session',
    created_by: 'test-user' as UUID,
  });

  return session.session_id as SessionID;
}

/**
 * Create a test task (optional FK for messages)
 */
async function createTestTask(db: any, sessionId: SessionID): Promise<TaskID> {
  const taskRepo = new TaskRepository(db);

  const task = await taskRepo.create({
    session_id: sessionId,
    full_prompt: 'Test task',
    message_range: { start_index: 0, end_index: 10, start_timestamp: new Date().toISOString() },
    created_by: 'test-user' as UUID,
  });

  return task.task_id as TaskID;
}

// ============================================================================
// Create
// ============================================================================

describe('MessagesRepository.create', () => {
  dbTest('rejects noncanonical supplied IDs before SQLite persistence', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    await expect(
      messages.create(
        createMessageData({
          session_id: sessionId,
          message_id: `${generateId()}-overlength` as MessageID,
        })
      )
    ).rejects.toThrow('message_id must be a canonical full UUID');
    await expect(messages.findBySessionId(sessionId)).resolves.toEqual([]);
  });

  dbTest('sanitizes PostgreSQL-invalid Unicode in JSON and preview fields', async ({ db }) => {
    const actualNul = String.fromCharCode(0);
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdc00);
    const repository = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const original = createMessageData({
      session_id: sessionId,
      content_preview: `preview${actualNul}${loneHighSurrogate}`,
      content: [
        { type: 'tool_result', content: `binary${actualNul}${loneLowSurrogate} 😀` },
      ] as Message['content'],
      metadata: { nested: [actualNul] } as Message['metadata'],
    });

    const created = await repository.create(original);
    expect(created.content_preview).toBe('preview��');
    expect(created.content).toEqual([{ type: 'tool_result', content: 'binary�� 😀' }]);
    expect(created.metadata).toEqual({ nested: ['�'] });
    expect(original.content_preview).toBe(`preview${actualNul}${loneHighSurrogate}`);
  });
  dbTest('should create message with all fields including task_id', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const taskId = await createTestTask(db, sessionId);

    const data = createMessageData({
      session_id: sessionId,
      task_id: taskId,
      content: 'Hello world',
      content_preview: 'Hello world',
    });

    const created = await messages.create(data);

    expect(created.message_id).toBe(data.message_id);
    expect(created.session_id).toBe(sessionId);
    expect(created.task_id).toBe(taskId);
    expect(created.type).toBe('user');
    expect(created.role).toBe(MessageRole.USER);
    expect(created.index).toBe(0);
    expect(created.content).toBe('Hello world');
    expect(created.content_preview).toBe('Hello world');
    expect(created.timestamp).toBeDefined();
  });

  dbTest('should create message without optional task_id', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const data = createMessageData({ session_id: sessionId });
    const created = await messages.create(data);

    expect(created.task_id).toBeUndefined();
  });

  dbTest('rejects a Task from a different Session during create', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const messageSessionId = await createTestSession(db);
    const taskSessionId = await createTestSession(db);
    const taskId = await createTestTask(db, taskSessionId);

    await expect(
      messages.create(createMessageData({ session_id: messageSessionId, task_id: taskId }))
    ).rejects.toThrow('task_id must belong to the Message Session');
  });

  dbTest('rejects a taskless Message whose parent Session does not exist', async ({ db }) => {
    const messages = new MessagesRepository(db);
    await expect(
      messages.create(
        createMessageData({
          session_id: '99999999-9999-7999-8999-999999999999' as SessionID,
        })
      )
    ).rejects.toThrow('session_id must belong to the current tenant');
  });

  dbTest('should store all JSON fields (content, tool_uses, metadata)', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const contentBlocks = [
      { type: 'text', text: 'Hello' },
      { type: 'image', url: 'https://example.com/image.png' },
    ];

    const toolUses = [
      {
        id: 'tool-1',
        name: 'read_file',
        input: { path: '/test/file.ts' },
      },
    ];

    const metadata = {
      model: 'claude-3-5-sonnet-20241022',
      tokens: { input: 100, output: 50 },
      original_id: 'msg_abc123',
    };

    const data = createMessageData({
      session_id: sessionId,
      role: MessageRole.ASSISTANT,
      content: contentBlocks as any,
      tool_uses: toolUses,
      metadata,
    });

    const created = await messages.create(data);

    expect(created.content).toEqual(contentBlocks);
    expect(created.tool_uses).toEqual(toolUses);
    expect(created.metadata).toEqual(metadata);
  });
});

// ============================================================================
// FindById
// ============================================================================

describe('MessagesRepository.findById', () => {
  dbTest('should find message by ID with all fields', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const taskId = await createTestTask(db, sessionId);

    const data = createMessageData({
      session_id: sessionId,
      task_id: taskId,
      content: 'Full message',
      tool_uses: [{ id: 'tool-1', name: 'read', input: {} }],
      metadata: { model: 'claude-3', tokens: { input: 10, output: 5 } },
    });

    await messages.create(data);

    const found = await messages.findById(data.message_id);

    expect(found?.message_id).toBe(data.message_id);
    expect(found?.session_id).toBe(sessionId);
    expect(found?.task_id).toBe(taskId);
    expect(found?.content).toBe('Full message');
    expect(found?.tool_uses).toEqual([{ id: 'tool-1', name: 'read', input: {} }]);
    expect(found?.metadata).toEqual({ model: 'claude-3', tokens: { input: 10, output: 5 } });
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const messages = new MessagesRepository(db);

    const found = await messages.findById('99999999-9999-9999-9999-999999999999' as MessageID);

    expect(found).toBeNull();
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('MessagesRepository.findAll', () => {
  dbTest('should return all messages ordered by index', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    // Create messages out of order
    await messages.create(createMessageData({ session_id: sessionId, index: 2 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 0 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 1 }));

    const all = await messages.findAll();

    expect(all).toHaveLength(3);
    expect(all[0].index).toBe(0);
    expect(all[1].index).toBe(1);
    expect(all[2].index).toBe(2);
  });

  dbTest('should restrict by visibleToUserId through session branch access', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const sessions = new SessionRepository(db);
    const viewerId = generateId() as UUID;
    await users.create({
      user_id: viewerId,
      email: 'messages-visible@example.com',
      name: 'Messages Viewer',
    });
    const repo = await repos.create({
      slug: `messages-visible-${testCounter++}`,
      name: 'Messages Visible',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: `/tmp/messages-visible-${testCounter}`,
      default_branch: 'main',
    });
    const visibleBranch = await branches.create({
      repo_id: repo.repo_id,
      name: `visible-${testCounter}`,
      path: `/tmp/visible-${testCounter}`,
      ref: 'main',
      branch_unique_id: testCounter++,
      created_by: 'test-user' as UUID,
      permission_source: 'override',
      others_can: 'none',
    });
    const hiddenBranch = await branches.create({
      repo_id: repo.repo_id,
      name: `hidden-${testCounter}`,
      path: `/tmp/hidden-${testCounter}`,
      ref: 'main',
      branch_unique_id: testCounter++,
      created_by: 'test-user' as UUID,
      permission_source: 'override',
      others_can: 'none',
    });
    await setTestBranchUserRole(db, visibleBranch.branch_id, viewerId as UserID, 'manager');
    const visibleSession = await sessions.create({
      branch_id: visibleBranch.branch_id,
      title: 'visible',
      created_by: 'test-user' as UUID,
    });
    const hiddenSession = await sessions.create({
      branch_id: hiddenBranch.branch_id,
      title: 'hidden',
      created_by: 'test-user' as UUID,
    });
    const visibleMessage = await messages.create(
      createMessageData({ session_id: visibleSession.session_id as SessionID, index: 0 })
    );
    await messages.create(
      createMessageData({ session_id: hiddenSession.session_id as SessionID, index: 1 })
    );

    const visible = await messages.findAll({ visibleToUserId: viewerId });
    expect(visible.map((m) => m.message_id)).toEqual([visibleMessage.message_id]);

    const visiblePage = await messages.findPage({ visibleToUserId: viewerId, limit: 1, skip: 0 });
    expect(visiblePage.total).toBe(1);
    expect(visiblePage.data.map((m) => m.message_id)).toEqual([visibleMessage.message_id]);
  });
});

describe('MessagesRepository.findPage', () => {
  dbTest('counts exact matches and hydrates only the ordered page', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    await createMessages(
      messages,
      Array.from({ length: 32 }, (_, index) =>
        createMessageData({
          session_id: sessionId,
          index,
          role: MessageRole.ASSISTANT,
          content: {
            index,
            payload: new Array(100).fill(`message-${index}`),
          } as unknown as Message['content'],
        })
      )
    );

    const client = (
      db as unknown as {
        $client: { execute: (...args: unknown[]) => Promise<unknown> };
      }
    ).$client;
    const execute = vi.spyOn(client, 'execute');
    const page = await messages.findPage({
      sessionId,
      role: MessageRole.ASSISTANT,
      sort: { index: 1 },
      limit: 2,
      skip: 7,
    });

    expect(page.total).toBe(32);
    expect(page.data.map((message) => message.index)).toEqual([7, 8]);
    expect(
      execute.mock.calls
        .map(([query]) => JSON.stringify(query))
        .some((query) => /limit/i.test(query))
    ).toBe(true);
  });

  dbTest('appends message_id to preserve stable ordering across tied pages', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const tiedMessages = [
      createMessageData({
        message_id: '00000000-0000-0000-0000-000000000003' as MessageID,
        session_id: sessionId,
        index: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      createMessageData({
        message_id: '00000000-0000-0000-0000-000000000001' as MessageID,
        session_id: sessionId,
        index: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      createMessageData({
        message_id: '00000000-0000-0000-0000-000000000002' as MessageID,
        session_id: sessionId,
        index: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ];
    await createMessages(messages, tiedMessages);
    for (const tiedMessage of tiedMessages) {
      await update(db, messagesTable)
        .set({ created_at: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(messagesTable.message_id, tiedMessage.message_id))
        .run();
    }

    const firstPage = await messages.findPage({
      sessionId,
      sort: { created_at: -1 },
      limit: 2,
      skip: 0,
    });
    const secondPage = await messages.findPage({
      sessionId,
      sort: { created_at: -1 },
      limit: 2,
      skip: 2,
    });

    expect(firstPage.data.map((message) => message.message_id)).toEqual([
      tiedMessages[1].message_id,
      tiedMessages[2].message_id,
    ]);
    expect(secondPage.data.map((message) => message.message_id)).toEqual([
      tiedMessages[0].message_id,
    ]);
    expect([...firstPage.data, ...secondPage.data].map((message) => message.message_id)).toEqual(
      [...tiedMessages]
        .sort((left, right) => left.message_id.localeCompare(right.message_id))
        .map((message) => message.message_id)
    );
  });

  dbTest('projects selected fields in the repository page query', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const created = await messages.create(
      createMessageData({
        session_id: sessionId,
        content: 'large payload that an ID-only hydration pass must not decode',
      })
    );

    const idsOnly = await messages.findPage({
      sessionId,
      select: ['message_id'],
      limit: 10,
    });
    expect(idsOnly).toEqual({ total: 1, data: [{ message_id: created.message_id }] });

    const contentOnly = await messages.findPage({
      sessionId,
      select: ['message_id', 'content'],
      limit: 10,
    });
    expect(contentOnly).toEqual({
      total: 1,
      data: [{ message_id: created.message_id, content: created.content }],
    });
  });
});

// ============================================================================
// FindBySessionId
// ============================================================================

describe('MessagesRepository.findBySessionId', () => {
  dbTest('should find all messages for session ordered by index', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId1 = await createTestSession(db);
    const sessionId2 = await createTestSession(db);

    // Insert out of order for session1
    await messages.create(createMessageData({ session_id: sessionId1, index: 5 }));
    await messages.create(createMessageData({ session_id: sessionId1, index: 1 }));
    await messages.create(createMessageData({ session_id: sessionId1, index: 3 }));
    // Add session2 message to verify filtering
    await messages.create(createMessageData({ session_id: sessionId2, index: 0 }));

    const sessionMessages = await messages.findBySessionId(sessionId1);

    expect(sessionMessages).toHaveLength(3);
    expect(sessionMessages[0].index).toBe(1);
    expect(sessionMessages[1].index).toBe(3);
    expect(sessionMessages[2].index).toBe(5);
    expect(sessionMessages.every((m) => m.session_id === sessionId1)).toBe(true);
  });
});

// ============================================================================
// FindByTaskId
// ============================================================================

describe('MessagesRepository.findByTaskId', () => {
  dbTest('should find all messages for task ordered by index', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const taskId1 = await createTestTask(db, sessionId);
    const taskId2 = await createTestTask(db, sessionId);

    // Insert out of order for task1
    await messages.create(createMessageData({ session_id: sessionId, task_id: taskId1, index: 5 }));
    await messages.create(createMessageData({ session_id: sessionId, task_id: taskId1, index: 1 }));
    await messages.create(createMessageData({ session_id: sessionId, task_id: taskId1, index: 3 }));
    // Add task2 message and message without task_id to verify filtering
    await messages.create(createMessageData({ session_id: sessionId, task_id: taskId2, index: 0 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 2 }));

    const taskMessages = await messages.findByTaskId(taskId1);

    expect(taskMessages).toHaveLength(3);
    expect(taskMessages[0].index).toBe(1);
    expect(taskMessages[1].index).toBe(3);
    expect(taskMessages[2].index).toBe(5);
    expect(taskMessages.every((m) => m.task_id === taskId1)).toBe(true);
  });
});

// ============================================================================
// FindByRange
// ============================================================================

describe('MessagesRepository.findByRange', () => {
  dbTest('should return messages within inclusive range for session', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId1 = await createTestSession(db);
    const sessionId2 = await createTestSession(db);

    // Create messages with indexes 0-9 for session1
    for (let i = 0; i < 10; i++) {
      await messages.create(createMessageData({ session_id: sessionId1, index: i }));
    }
    // Add session2 messages to verify filtering
    await messages.create(createMessageData({ session_id: sessionId2, index: 3 }));

    const rangeMessages = await messages.findByRange(sessionId1, 2, 5);

    expect(rangeMessages).toHaveLength(4); // 2, 3, 4, 5 (inclusive)
    expect(rangeMessages.map((m) => m.index)).toEqual([2, 3, 4, 5]);
    expect(rangeMessages.every((m) => m.session_id === sessionId1)).toBe(true);
  });

  dbTest('should handle sparse indexes in range', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    // Create messages with gaps: 0, 2, 5, 8
    await messages.create(createMessageData({ session_id: sessionId, index: 0 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 2 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 5 }));
    await messages.create(createMessageData({ session_id: sessionId, index: 8 }));

    const rangeMessages = await messages.findByRange(sessionId, 1, 6);

    expect(rangeMessages).toHaveLength(2); // Only 2 and 5
    expect(rangeMessages[0].index).toBe(2);
    expect(rangeMessages[1].index).toBe(5);
  });
});

// ============================================================================
// Update
// ============================================================================

describe('MessagesRepository.update', () => {
  dbTest('preserves the immutable database creation timestamp', async ({ db }) => {
    const repository = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const created = await repository.create(createMessageData({ session_id: sessionId }));
    const originalCreatedAt = new Date('2024-01-02T03:04:05.000Z');
    await update(db, messagesTable)
      .set({ created_at: originalCreatedAt })
      .where(eq(messagesTable.message_id, created.message_id))
      .run();

    await repository.update(created.message_id, { content_preview: 'patched' });

    const row = await select(db, { created_at: messagesTable.created_at })
      .from(messagesTable)
      .where(eq(messagesTable.message_id, created.message_id))
      .one();
    expect(row?.created_at).toEqual(originalCreatedAt);
  });

  dbTest('updates mutable content while preserving immutable identity fields', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const data = createMessageData({
      session_id: sessionId,
      content: 'Original',
      role: MessageRole.USER,
      index: 5,
      metadata: { model: 'claude-3' },
    });
    const created = await messages.create(data);

    const updated = await messages.update(created.message_id, {
      content: 'Updated',
      role: MessageRole.ASSISTANT,
      type: 'system',
      index: 99,
    });

    expect(updated.content).toBe('Updated');
    expect(updated.role).toBe(MessageRole.USER);
    expect(updated.type).toBe(data.type);
    expect(updated.index).toBe(5); // Preserved
    expect(updated.metadata).toEqual({ model: 'claude-3' }); // Preserved
  });

  dbTest('serializes patches so distinct mutable fields are not lost', async ({ db }) => {
    const repository = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const created = await repository.create(
      createMessageData({ session_id: sessionId, content: 'before', metadata: { before: true } })
    );

    await Promise.all([
      repository.update(created.message_id, { content: 'after' }),
      repository.update(created.message_id, { metadata: { patched: true } }),
    ]);

    await expect(repository.findById(created.message_id)).resolves.toMatchObject({
      content: 'after',
      metadata: { patched: true },
    });
  });

  dbTest('sanitizes all JSON and preview fields on finalization update', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const created = await messages.create(
      createMessageData({ session_id: sessionId, content: 'Original', metadata: { keep: true } })
    );

    const updated = await messages.update(created.message_id, {
      content: [{ type: 'tool_result', content: 'binary\0result' }] as Message['content'],
      content_preview: 'binary\0preview',
      tool_uses: [{ id: 'tool-1', name: 'read', input: { 'bad\0key': '\ud800' } }],
    });

    expect(updated.content).toEqual([{ type: 'tool_result', content: 'binary�result' }]);
    expect(updated.content_preview).toBe('binary�preview');
    expect(updated.tool_uses).toEqual([{ id: 'tool-1', name: 'read', input: { 'bad�key': '�' } }]);
    expect(updated.metadata).toEqual({ keep: true });
  });

  dbTest(
    'persists a bounded placeholder when final content exceeds the safety budget',
    async ({ db }) => {
      const messages = new MessagesRepository(db);
      const sessionId = await createTestSession(db);
      const created = await messages.create(createMessageData({ session_id: sessionId }));
      const oversized = new Array(JSON_SANITIZER_LIMITS.maxNodes).fill(null);

      const updated = await messages.update(created.message_id, {
        content: oversized as Message['content'],
        content_preview: 'untrusted preview',
        metadata: { secret: 'must be dropped' },
      });

      expect(updated.content).toBe(MESSAGE_CONTENT_OMITTED);
      expect(updated.content_preview).toBe(MESSAGE_CONTENT_OMITTED);
      expect(updated.tool_uses).toBeUndefined();
      expect(updated.metadata).toEqual({ persistence_omission: { reason: 'size' } });
      expect(updated.metadata).not.toHaveProperty('secret');
    }
  );

  dbTest('should throw error for non-existent message', async ({ db }) => {
    const messages = new MessagesRepository(db);

    await expect(
      messages.update('99999999-9999-9999-9999-999999999999', { content: 'Updated' })
    ).rejects.toThrow('not found');
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('MessagesRepository.delete', () => {
  dbTest('should delete message by ID without affecting others', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const data1 = createMessageData({ session_id: sessionId, index: 0 });
    const data2 = createMessageData({ session_id: sessionId, index: 1 });
    const created1 = await messages.create(data1);
    const created2 = await messages.create(data2);

    await messages.delete(created1.message_id);

    const found = await messages.findById(created1.message_id);
    expect(found).toBeNull();

    const remaining = await messages.findBySessionId(sessionId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message_id).toBe(created2.message_id);
  });
});

// ============================================================================
// DeleteBySessionId (Bulk Delete)
// ============================================================================

describe('MessagesRepository.deleteBySessionId', () => {
  dbTest('should delete all messages for session without affecting others', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId1 = await createTestSession(db);
    const sessionId2 = await createTestSession(db);

    // Create 100 messages for session1 (test bulk delete efficiency)
    const messageList = Array.from({ length: 100 }, (_, i) =>
      createMessageData({ session_id: sessionId1, index: i })
    );
    await createMessages(messages, messageList);

    // Create messages for session2
    await messages.create(createMessageData({ session_id: sessionId2, index: 0 }));

    await messages.deleteBySessionId(sessionId1);

    const session1Messages = await messages.findBySessionId(sessionId1);
    const session2Messages = await messages.findBySessionId(sessionId2);

    expect(session1Messages).toEqual([]);
    expect(session2Messages).toHaveLength(1);
  });
});

// ============================================================================
// JSON Data and Edge Cases
// ============================================================================

describe('MessagesRepository JSON and edge cases', () => {
  dbTest('should preserve complex nested JSON structures', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const complexMetadata = {
      model: 'claude-3-5-sonnet-20241022',
      tokens: { input: 1000, output: 500, cache_read: 200, cache_write: 100 },
      original_id: 'msg_abc123',
      custom_fields: {
        temperature: 0.7,
        max_tokens: 4096,
        stop_sequences: ['\n\n'],
      },
    };

    const data = createMessageData({
      session_id: sessionId,
      metadata: complexMetadata,
    });

    const created = await messages.create(data);

    expect(created.metadata).toEqual(complexMetadata);
  });

  dbTest('should handle special characters and unicode', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const specialContent = 'Test "quotes", \'apostrophes\', \n newlines 世界 🌍';

    const data = createMessageData({ session_id: sessionId, content: specialContent });
    const created = await messages.create(data);

    expect(created.content).toBe(specialContent);
  });
});

describe('MessagesRepository.mutateMetadataLocked', () => {
  dbTest('elects one widget resolver across concurrent SQLite writers', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const message = createMessageData({
      session_id: sessionId,
      type: 'widget_request',
      role: MessageRole.SYSTEM,
      metadata: {
        widget: {
          widget_id: generateId() as MessageID,
          widget_type: 'test',
          schema_version: 1,
          params: {},
          status: 'pending',
          requested_at: new Date().toISOString(),
        },
      },
    });
    message.metadata!.widget!.widget_id = message.message_id;
    await new MessagesRepository(db).create(message);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        new MessagesRepository(db).mutateMetadataLocked(message.message_id, (metadata) => {
          const widget = metadata?.widget;
          if (widget?.status !== 'pending') return null;
          return {
            ...metadata,
            widget: {
              ...widget,
              status: 'resolving',
              resolution_claim: {
                token: `claim-${index}`,
                action: index % 2 === 0 ? 'submit' : 'dismiss',
                claimed_at: new Date().toISOString(),
                claimed_by: 'test-user' as UUID,
              },
            },
          };
        })
      )
    );

    expect(attempts.filter((attempt) => attempt.changed)).toHaveLength(1);
    const stored = await new MessagesRepository(db).findById(message.message_id);
    expect(stored?.metadata?.widget?.status).toBe('resolving');
  });
});
