import { describe, expect, it, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { MessageID, SessionID, TaskID } from '../../types';
import { MessageRole } from '../../types';
import type { MessagesService, TasksService } from './claude-tool';
import {
  createAssistantMessage,
  createUserMessage,
  createUserMessageFromContent,
  extractTokenUsage,
} from './message-builder';

describe('extractTokenUsage', () => {
  describe('valid token usage extraction', () => {
    it('should extract input tokens only', () => {
      const raw = { input_tokens: 1000 };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: 1000,
        output_tokens: undefined,
        total_tokens: undefined,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });

    it('should extract output tokens only', () => {
      const raw = { output_tokens: 500 };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: undefined,
        output_tokens: 500,
        total_tokens: undefined,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });

    it('should extract all token types', () => {
      const raw = {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
      };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 200,
        cache_creation_tokens: 300,
      });
    });

    it('should handle SDK field names for cache tokens', () => {
      const raw = {
        input_tokens: 1000,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 200,
      };
      const result = extractTokenUsage(raw);

      expect(result?.cache_read_tokens).toBe(100);
      expect(result?.cache_creation_tokens).toBe(200);
    });

    it('should handle zero values', () => {
      const raw = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });

    it('should handle large token counts', () => {
      const raw = {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      };
      const result = extractTokenUsage(raw);

      expect(result?.input_tokens).toBe(1_000_000);
      expect(result?.output_tokens).toBe(500_000);
    });
  });

  describe('invalid inputs', () => {
    it('should return undefined for null', () => {
      expect(extractTokenUsage(null)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(extractTokenUsage(undefined)).toBeUndefined();
    });

    it('should return undefined for non-object primitives', () => {
      expect(extractTokenUsage('string')).toBeUndefined();
      expect(extractTokenUsage(123)).toBeUndefined();
      expect(extractTokenUsage(true)).toBeUndefined();
    });

    it('should return undefined for arrays', () => {
      expect(extractTokenUsage([1, 2, 3])).toBeUndefined();
    });

    it('should skip non-number fields', () => {
      const raw = {
        input_tokens: 'not a number',
        output_tokens: 500,
        total_tokens: null,
      };
      const result = extractTokenUsage(raw);

      expect(result?.input_tokens).toBeUndefined();
      expect(result?.output_tokens).toBe(500);
      expect(result?.total_tokens).toBeUndefined();
    });

    it('should handle empty object', () => {
      const result = extractTokenUsage({});

      expect(result).toEqual({
        input_tokens: undefined,
        output_tokens: undefined,
        total_tokens: undefined,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });

    it('should handle object with unrelated fields', () => {
      const raw = {
        foo: 'bar',
        baz: 123,
        nested: { value: 456 },
      };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: undefined,
        output_tokens: undefined,
        total_tokens: undefined,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });

    it('should handle mixed valid and invalid fields', () => {
      const raw = {
        input_tokens: 1000,
        output_tokens: 'invalid',
        cache_read_input_tokens: null,
        total_tokens: 1500,
      };
      const result = extractTokenUsage(raw);

      expect(result).toEqual({
        input_tokens: 1000,
        output_tokens: undefined,
        total_tokens: 1500,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
    });
  });
});

describe('createUserMessage', () => {
  function createMockMessagesService(): MessagesService {
    return {
      create: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagesService;
  }

  it('should create user message with basic fields', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const taskId = generateId() as TaskID;
    const prompt = 'Hello, Claude!';

    const result = await createUserMessage(sessionId, prompt, taskId, 0, messagesService);

    expect(result.session_id).toBe(sessionId);
    expect(result.task_id).toBe(taskId);
    expect(result.type).toBe('user');
    expect(result.role).toBe(MessageRole.USER);
    expect(result.index).toBe(0);
    expect(result.content).toBe(prompt);
    expect(result.content_preview).toBe(prompt);
    expect(messagesService.create).toHaveBeenCalledWith(result);
  });

  it('should generate valid message ID', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;

    const result = await createUserMessage(sessionId, 'test', undefined, 0, messagesService);

    expect(result.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('should truncate long prompts in preview', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const longPrompt = 'a'.repeat(300);

    const result = await createUserMessage(sessionId, longPrompt, undefined, 0, messagesService);

    expect(result.content_preview).toBe('a'.repeat(200));
    expect(result.content).toBe(longPrompt);
  });

  it('should handle short prompts without truncation', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const shortPrompt = 'Short prompt';

    const result = await createUserMessage(sessionId, shortPrompt, undefined, 0, messagesService);

    expect(result.content_preview).toBe(shortPrompt);
    expect(result.content).toBe(shortPrompt);
  });

  it('should handle empty prompt', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;

    const result = await createUserMessage(sessionId, '', undefined, 0, messagesService);

    expect(result.content).toBe('');
    expect(result.content_preview).toBe('');
  });

  it('should handle undefined task_id', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;

    const result = await createUserMessage(sessionId, 'test', undefined, 0, messagesService);

    expect(result.task_id).toBeUndefined();
  });

  it('should handle various index values', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;

    const result0 = await createUserMessage(sessionId, 'msg0', undefined, 0, messagesService);
    const result5 = await createUserMessage(sessionId, 'msg5', undefined, 5, messagesService);
    const result100 = await createUserMessage(sessionId, 'msg100', undefined, 100, messagesService);

    expect(result0.index).toBe(0);
    expect(result5.index).toBe(5);
    expect(result100.index).toBe(100);
  });

  it('should set ISO timestamp', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const before = new Date().toISOString();

    const result = await createUserMessage(sessionId, 'test', undefined, 0, messagesService);

    const after = new Date().toISOString();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });

  it('should handle multiline prompts', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const multilinePrompt = 'Line 1\nLine 2\nLine 3';

    const result = await createUserMessage(
      sessionId,
      multilinePrompt,
      undefined,
      0,
      messagesService
    );

    expect(result.content).toBe(multilinePrompt);
    expect(result.content_preview).toBe(multilinePrompt);
  });
});

describe('createUserMessageFromContent', () => {
  function createMockMessagesService(): MessagesService {
    return {
      create: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagesService;
  }

  it('should create user message from text content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'Hello from tool' }];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.message_id).toBe(messageId);
    expect(result.session_id).toBe(sessionId);
    expect(result.type).toBe('user');
    expect(result.role).toBe(MessageRole.USER);
    expect(result.content).toEqual(content);
    expect(result.content_preview).toBe('Hello from tool');
  });

  it('should create preview from tool_result with string content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-123',
        content: 'Tool execution result',
      },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('Tool result: Tool execution result');
  });

  it('should create preview from tool_result with object content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-123',
        content: { status: 'success', data: 'result' },
      },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('Tool result: {"status":"success","data":"result"}');
  });

  it('should truncate long tool result previews', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const longResult = 'x'.repeat(300);
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-123',
        content: longResult,
      },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe(`Tool result: ${'x'.repeat(180)}`);
    expect(result.content_preview.length).toBe(193); // "Tool result: " + 180 chars
  });

  it('should prefer text content over tool_result for preview', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      { type: 'tool_result', tool_use_id: 'tool-123', content: 'Tool result' },
      { type: 'text', text: 'Text content' },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('Tool result: Tool result');
  });

  it('should handle empty content array', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      [],
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('');
    expect(result.content).toEqual([]);
  });

  it('should handle content with no text or tool_result', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'image', source: { type: 'base64', data: 'abc123' } }];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('');
  });

  it('should handle tool_result with is_error flag', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-123',
        content: 'Error occurred',
        is_error: true,
      },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('Tool result: Error occurred');
  });

  it('should use provided message ID', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.message_id).toBe(messageId);
  });

  it('should handle multiple content blocks', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      { type: 'text', text: 'First text' },
      { type: 'text', text: 'Second text' },
      { type: 'tool_result', tool_use_id: 'tool-123', content: 'Result' },
    ];

    const result = await createUserMessageFromContent(
      sessionId,
      messageId,
      content,
      undefined,
      1,
      messagesService
    );

    expect(result.content_preview).toBe('First text');
  });
});

describe('createAssistantMessage', () => {
  function createMockMessagesService(): MessagesService {
    return {
      create: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagesService;
  }

  function createMockTasksService(): TasksService {
    return {
      patch: vi.fn().mockResolvedValue(undefined),
    } as unknown as TasksService;
  }

  it('should create assistant message with text content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'Hello, I am Claude!' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      'claude-sonnet-4-5',
      messagesService
    );

    expect(result.message_id).toBe(messageId);
    expect(result.session_id).toBe(sessionId);
    expect(result.type).toBe('assistant');
    expect(result.role).toBe(MessageRole.ASSISTANT);
    expect(result.content).toEqual(content);
    expect(result.content_preview).toBe('Hello, I am Claude!');
    expect(result.metadata?.model).toBe('claude-sonnet-4-5');
  });

  it('should extract text from multiple text blocks', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      { type: 'text', text: 'First paragraph. ' },
      { type: 'text', text: 'Second paragraph.' },
    ];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content_preview).toBe('First paragraph. Second paragraph.');
  });

  it('should truncate long text content in preview', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const longText = 'a'.repeat(300);
    const content = [{ type: 'text', text: longText }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content_preview).toBe('a'.repeat(200));
  });

  it('should handle mixed text and tool_use content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [
      { type: 'text', text: 'I will run this tool' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'test.ts' } },
    ];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content_preview).toBe('I will run this tool');
    expect(result.content).toEqual(content);
  });

  it('should store tool_uses separately', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const toolUses = [
      { id: 'tool-1', name: 'read_file', input: { path: 'test.ts' } },
      { id: 'tool-2', name: 'write_file', input: { path: 'output.ts', content: 'code' } },
    ];
    const content = [{ type: 'text', text: 'Using tools' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      toolUses,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.tool_uses).toEqual(toolUses);
  });

  it('should handle empty text content', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: '' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content_preview).toBe('');
  });

  it('should handle content with no text blocks', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'ls' } }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content_preview).toBe('');
  });

  it('should use default model when resolvedModel is undefined', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.metadata?.model).toBe('claude-sonnet-4-5'); // DEFAULT_CLAUDE_MODEL
  });

  it('should update task with resolved model', async () => {
    const messagesService = createMockMessagesService();
    const tasksService = createMockTasksService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const taskId = generateId() as TaskID;
    const content = [{ type: 'text', text: 'test' }];

    await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      taskId,
      0,
      'claude-opus-4-1',
      messagesService,
      tasksService
    );

    expect(tasksService.patch).toHaveBeenCalledWith(taskId, { model: 'claude-opus-4-1' });
  });

  it('should not update task when taskId is undefined', async () => {
    const messagesService = createMockMessagesService();
    const tasksService = createMockTasksService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];

    await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      'claude-sonnet-4-5',
      messagesService,
      tasksService
    );

    expect(tasksService.patch).not.toHaveBeenCalled();
  });

  it('should not update task when resolvedModel is undefined', async () => {
    const messagesService = createMockMessagesService();
    const tasksService = createMockTasksService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const taskId = generateId() as TaskID;
    const content = [{ type: 'text', text: 'test' }];

    await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      taskId,
      0,
      undefined,
      messagesService,
      tasksService
    );

    expect(tasksService.patch).not.toHaveBeenCalled();
  });

  it('should not update task when tasksService is undefined', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const taskId = generateId() as TaskID;
    const content = [{ type: 'text', text: 'test' }];

    await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      taskId,
      0,
      'claude-sonnet-4-5',
      messagesService,
      undefined
    );

    // No error should occur
    expect(messagesService.create).toHaveBeenCalled();
  });

  it('should use token usage when provided', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];
    const tokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
    };

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService,
      undefined,
      undefined,
      tokenUsage
    );

    expect(result.metadata?.tokens).toEqual({
      input: 1000,
      output: 500,
    });
  });

  it('should default to zeros when token usage not provided', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.metadata?.tokens).toEqual({
      input: 0,
      output: 0,
    });
  });

  it('should set ISO timestamp', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];
    const before = new Date().toISOString();

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    const after = new Date().toISOString();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });

  it('should handle various index values', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'test' }];

    const result0 = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );
    const result10 = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      10,
      undefined,
      messagesService
    );

    expect(result0.index).toBe(0);
    expect(result10.index).toBe(10);
  });

  it('should preserve content structure with special characters', async () => {
    const messagesService = createMockMessagesService();
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const content = [{ type: 'text', text: 'Code: `const x = 1;`\n\n**Bold** and *italic*' }];

    const result = await createAssistantMessage(
      sessionId,
      messageId,
      content,
      undefined,
      undefined,
      0,
      undefined,
      messagesService
    );

    expect(result.content).toEqual(content);
    expect(result.content_preview).toContain('`const x = 1;`');
  });
});
