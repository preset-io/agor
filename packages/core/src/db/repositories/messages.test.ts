/**
 * MessagesRepository Tests
 *
 * Tests for CRUD operations on conversation messages with bulk operations,
 * range filtering, and JSON data field handling.
 */

import type { Message, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { WorktreeRepository } from './worktrees';

// Counter to ensure unique repo/worktree names across tests
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

/**
 * Create a test session (required FK for messages)
 */
async function createTestSession(
  db: any,
  overrides?: { session_id?: UUID; worktree_id?: UUID }
): Promise<SessionID> {
  const sessionRepo = new SessionRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
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

  // Create worktree
  const worktree = await worktreeRepo.create({
    worktree_id: overrides?.worktree_id,
    repo_id: repo.repo_id,
    name: `test-worktree-${uniqueId}`,
    path: `/test/worktree/${uniqueId}`,
    ref: 'main',
    worktree_unique_id: uniqueId,
  });

  // Create session
  const session = await sessionRepo.create({
    session_id: overrides?.session_id,
    worktree_id: worktree.worktree_id,
    title: 'Test Session',
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
  });

  return task.task_id as TaskID;
}

// ============================================================================
// Create
// ============================================================================

describe('MessagesRepository.create', () => {
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
// CreateMany (Bulk Insert)
// ============================================================================

describe('MessagesRepository.createMany', () => {
  dbTest('should bulk insert multiple messages and preserve order', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);

    const messageList = Array.from({ length: 10 }, (_, i) =>
      createMessageData({
        session_id: sessionId,
        index: i,
        content: `Message ${i}`,
      })
    );

    const created = await messages.createMany(messageList);

    expect(created).toHaveLength(10);
    created.forEach((msg, i) => {
      expect(msg.index).toBe(i);
      expect(msg.content).toBe(`Message ${i}`);
    });
  });

  dbTest('should throw error for empty array', async ({ db }) => {
    const messages = new MessagesRepository(db);

    // Drizzle's .values() requires at least one value
    await expect(messages.createMany([])).rejects.toThrow(
      'values() must be called with at least one value'
    );
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
  dbTest('should update message fields and preserve unchanged fields', async ({ db }) => {
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
    });

    expect(updated.content).toBe('Updated');
    expect(updated.role).toBe(MessageRole.ASSISTANT);
    expect(updated.index).toBe(5); // Preserved
    expect(updated.metadata).toEqual({ model: 'claude-3' }); // Preserved
  });

  dbTest('should throw error for non-existent message', async ({ db }) => {
    const messages = new MessagesRepository(db);

    await expect(
      messages.update('99999999-9999-9999-9999-999999999999', { content: 'Updated' })
    ).rejects.toThrow('not found');
  });
});

// ============================================================================
// AssignToTask
// ============================================================================

describe('MessagesRepository.assignToTask', () => {
  dbTest('should assign and reassign message to task', async ({ db }) => {
    const messages = new MessagesRepository(db);
    const sessionId = await createTestSession(db);
    const taskId1 = await createTestTask(db, sessionId);
    const taskId2 = await createTestTask(db, sessionId);

    const data = createMessageData({
      session_id: sessionId,
      content: 'Test content',
      index: 5,
      metadata: { model: 'claude-3' },
    });
    const created = await messages.create(data);

    // Assign to first task
    const updated1 = await messages.assignToTask(created.message_id, taskId1);
    expect(updated1.task_id).toBe(taskId1);
    expect(updated1.content).toBe('Test content'); // Preserved

    // Reassign to second task
    const updated2 = await messages.assignToTask(created.message_id, taskId2);
    expect(updated2.task_id).toBe(taskId2);
    expect(updated2.index).toBe(5); // Preserved
    expect(updated2.metadata).toEqual({ model: 'claude-3' }); // Preserved
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
    await messages.createMany(messageList);

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
