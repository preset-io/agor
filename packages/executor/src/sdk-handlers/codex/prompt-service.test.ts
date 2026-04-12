/**
 * CodexPromptService Tests
 *
 * Focused test: Verify SDK instance caching to prevent memory leak (issue #133)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexPromptService } from './prompt-service.js';

// Track how many Codex instances were created (module-level state)
let mockInstanceCount = 0;
let mockStreamEvents: Array<Record<string, unknown>> = [];

async function* streamMockEvents() {
  for (const event of mockStreamEvents) {
    yield event;
  }
}

// Mock @agor/core/sdk to avoid spawning real Codex CLI processes
vi.mock('@agor/core/sdk', () => {
  class MockCodexClient {
    apiKey: string;
    instanceId: number;

    constructor(options: { apiKey?: string }) {
      this.apiKey = options.apiKey || '';
      this.instanceId = ++mockInstanceCount;
    }

    startThread() {
      return {
        id: 'mock-thread-id',
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }

    resumeThread(threadId: string) {
      return {
        id: threadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }
  }

  return {
    Codex: {
      Codex: MockCodexClient,
    },
  };
});

// Mock repositories and database
const mockMessagesRepo = {} as any;
const mockSessionsRepo = {
  findById: vi.fn(),
} as any;
const mockSessionMCPServerRepo = {
  listServers: vi.fn().mockResolvedValue([]),
} as any;
const mockWorktreesRepo = {
  findById: vi.fn(),
} as any;
const mockDb = {} as any;

describe('CodexPromptService - SDK Instance Caching (issue #133)', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockStreamEvents = [];
    vi.clearAllMocks();
  });

  it('should create exactly one Codex instance on initialization', () => {
    const initialCount = mockInstanceCount;

    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined, // reposRepo
      'test-api-key',
      mockDb
    );

    expect(mockInstanceCount).toBe(initialCount + 1);
  });

  it('should reuse the same Codex instance when API key has not changed', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined, // reposRepo
      'test-api-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Simulate multiple calls to refreshClient with the same API key
    // Access private method via type assertion for testing
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('test-api-key');
    serviceWithPrivate.refreshClient('test-api-key');
    serviceWithPrivate.refreshClient('test-api-key');

    // Should NOT create new instances - still same count
    expect(mockInstanceCount).toBe(countAfterInit);
  });

  it('should create a new Codex instance only when API key changes', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined, // reposRepo
      'initial-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Call with same API key - should NOT create new instance
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('initial-key');
    expect(mockInstanceCount).toBe(countAfterInit);

    // Call with different API key - SHOULD create new instance
    serviceWithPrivate.refreshClient('new-api-key');
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with same new key again - should NOT create another instance
    serviceWithPrivate.refreshClient('new-api-key');
    expect(mockInstanceCount).toBe(countAfterInit + 1);
  });

  it('should handle empty/undefined API keys correctly', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined, // reposRepo
      undefined,
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Call with empty string - should not recreate if already empty
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('');
    expect(mockInstanceCount).toBe(countAfterInit);

    // Call with actual key - should create new instance
    serviceWithPrivate.refreshClient('new-key');
    expect(mockInstanceCount).toBe(countAfterInit + 1);
  });
});

describe('CodexPromptService - Todo normalization', () => {
  it('maps codex todo_list to TodoWrite-compatible payload with inferred in_progress', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'todo-1',
        type: 'todo_list',
        items: [
          { text: 'Completed step', completed: true },
          { text: 'Current step', completed: false },
          { text: 'Next step', completed: false },
        ],
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'todo-1',
      name: 'TodoWrite',
      input: {
        todos: [
          {
            content: 'Completed step',
            activeForm: 'Completed step',
            status: 'completed',
          },
          {
            content: 'Current step',
            activeForm: 'Current step',
            status: 'in_progress',
          },
          {
            content: 'Next step',
            activeForm: 'Next step',
            status: 'pending',
          },
        ],
      },
    });
  });

  it('returns null for empty todo_list', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'todo-empty',
        type: 'todo_list',
        items: [],
      },
      'completed'
    );

    expect(toolUse).toBeNull();
  });

  it('emits only one TodoWrite tool_complete when both item.updated and item.completed fire', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    // Avoid filesystem/config setup noise in this focused stream test
    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexSessionContext = vi.fn().mockResolvedValue('/tmp');
    serviceWithPrivates.ensureCodexConfig = vi.fn().mockResolvedValue(0);
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      worktree_id: 'worktree-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockWorktreesRepo.findById.mockResolvedValue({
      worktree_id: 'worktree-1',
      path: process.cwd(),
    });

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.updated',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'Review API client changes', completed: false }],
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'Review API client changes', completed: false }],
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 20,
        },
      },
    ];

    const emitted: Array<{ type: string; toolUse?: { name?: string } }> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'review')) {
      emitted.push(event as { type: string; toolUse?: { name?: string } });
    }

    const todoCompletions = emitted.filter(
      (event) => event.type === 'tool_complete' && event.toolUse?.name === 'TodoWrite'
    );
    expect(todoCompletions).toHaveLength(1);
  });
});
