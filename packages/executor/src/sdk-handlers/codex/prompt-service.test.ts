/**
 * CodexPromptService Tests
 *
 * Focused test: Verify SDK instance caching to prevent memory leak (issue #133)
 *
 * KNOWN GAP: the `MockCodexClient` below captures `apiKey`, `baseUrl`, and
 * `config` only shallowly; it still does not emulate Codex CLI process
 * behavior or subscription-mode env scrubbing. Some streaming tests stub out
 * `ensureCodexInstructionsFile`, `buildMcpServersConfig`, and
 * `ensureCodexClient`. So the load-bearing behaviors of the
 * per-session-CODEX_HOME removal —
 * `model_instructions_file` injection, MCP server flattening, subscription-
 * mode env scrubbing, fingerprint-based cache invalidation on token rotation
 * — are NOT exercised here. End-to-end coverage for those lives in the
 * manual test matrix in PR #1136. A proper SDK-call-shape assertion suite
 * is queued as a follow-up.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appServerMocks = vi.hoisted(() => ({
  forkCodexThreadViaAppServer: vi.fn(),
}));

const mcpScopingMocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
}));

const mcpAuthMocks = vi.hoisted(() => ({
  resolveMCPAuthHeaders: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  getDaemonUrl: vi.fn(),
}));

import { CodexPromptService } from './prompt-service.js';

// Track how many Codex instances were created (module-level state)
let mockInstanceCount = 0;
// Track options each constructed instance saw, in creation order. Lets
// tests assert that custom OPENAI_BASE_URL values and session config flow into
// Codex.Codex().
let mockInstanceBaseUrls: Array<string | undefined> = [];
let mockInstanceConfigs: Array<unknown> = [];
let mockClosedInstanceIds: number[] = [];
let mockStreamEvents: Array<Record<string, unknown>> = [];
let mockStartThreadId: string | undefined = 'mock-thread-id';

async function* streamMockEvents() {
  for (const event of mockStreamEvents) {
    yield event;
  }
}

// Mock @agor/core/sdk to avoid spawning real Codex CLI processes
vi.mock('./app-server-client.js', () => appServerMocks);
vi.mock('../base/mcp-scoping.js', () => mcpScopingMocks);
vi.mock('@agor/core/tools/mcp/jwt-auth', () => mcpAuthMocks);
vi.mock('../../config.js', () => configMocks);

vi.mock('@agor/core/sdk', () => {
  class MockCodexClient {
    apiKey: string;
    baseUrl: string | undefined;
    instanceId: number;

    constructor(options: { apiKey?: string; baseUrl?: string; config?: unknown }) {
      this.apiKey = options.apiKey || '';
      this.baseUrl = options.baseUrl;
      this.instanceId = ++mockInstanceCount;
      mockInstanceBaseUrls.push(options.baseUrl);
      mockInstanceConfigs.push(options.config);
    }

    close() {
      mockClosedInstanceIds.push(this.instanceId);
    }

    startThread() {
      return {
        id: mockStartThreadId,
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
  update: vi.fn(),
} as any;
const mockSessionMCPServerRepo = {
  listServers: vi.fn().mockResolvedValue([]),
} as any;
const mockBranchesRepo = {
  findById: vi.fn(),
} as any;
const mockDb = {} as any;

describe('CodexPromptService - SDK Instance Caching (issue #133)', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadId = 'mock-thread-id';
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
    appServerMocks.forkCodexThreadViaAppServer.mockReset();
  });

  it('does not create a Codex instance on initialization before session MCP config is known', () => {
    const initialCount = mockInstanceCount;

    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined, // reposRepo
      'test-api-key',
      mockDb
    );

    expect(mockInstanceCount).toBe(initialCount);
  });

  it('should reuse the same Codex instance when API key and session config have not changed', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined, // reposRepo
      'test-api-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Simulate multiple calls with the same API key and same per-session config
    // Access private methods via type assertion for testing
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    serviceWithPrivate.refreshClient('test-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });

    // Should create only the lazily-initialized configured instance
    expect(mockInstanceCount).toBe(countAfterInit + 1);
  });

  it('should create a new Codex instance only when API key changes', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined, // reposRepo
      'initial-key',
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    const serviceWithPrivate = service as any;
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with same API key - should NOT create new instance
    serviceWithPrivate.refreshClient('initial-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with different API key - next configured ensure SHOULD create new instance
    serviceWithPrivate.refreshClient('new-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
    expect(mockClosedInstanceIds).toContain(1);

    // Call with same new key again - should NOT create another instance
    serviceWithPrivate.refreshClient('new-api-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
  });

  it('should handle empty/undefined API keys correctly', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined, // reposRepo
      undefined,
      mockDb
    );

    const countAfterInit = mockInstanceCount;

    // Call with empty string - should not instantiate if already empty and no
    // session config has been ensured yet.
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('');
    expect(mockInstanceCount).toBe(countAfterInit);

    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Call with actual key - should create new instance on next ensure
    serviceWithPrivate.refreshClient('new-key');
    await serviceWithPrivate.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
  });
});

describe('CodexPromptService - OPENAI_BASE_URL handling', () => {
  // These tests guard the per-user custom OpenAI-compatible endpoint surface.
  // The SDK takes baseUrl via its CodexOptions, so we assert the env var is
  // read, trimmed, propagated to Codex.Codex(), and treated as a refresh
  // signal independent of API-key changes.
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
  });

  const makeService = (apiKey: string | undefined) =>
    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      apiKey,
      mockDb
    );

  it('passes OPENAI_BASE_URL into Codex.Codex when session config is ensured', async () => {
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1';
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual(['https://gateway.example.com/v1']);
  });

  it('omits baseUrl when OPENAI_BASE_URL is unset', async () => {
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual([undefined]);
  });

  it('trims whitespace and treats whitespace-only as unset', async () => {
    process.env.OPENAI_BASE_URL = '   ';
    const service = makeService('test-api-key') as any;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceBaseUrls).toEqual([undefined]);
  });

  it('reinitializes Codex when OPENAI_BASE_URL changes between refreshes', async () => {
    const service = makeService('stable-key') as any;
    const countAfterInit = mockInstanceCount;
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 1);

    // Same key, base URL appears -> next ensure must recreate.
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1';
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);
    expect(mockInstanceBaseUrls.at(-1)).toBe('https://gateway.example.com/v1');

    // Same key, same URL -> must NOT recreate (issue #133 protection).
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 2);

    // Same key, URL cleared -> must recreate without baseUrl.
    delete process.env.OPENAI_BASE_URL;
    service.refreshClient('stable-key');
    await service.ensureCodexClient({ model_instructions_file: '/tmp/a.md' });
    expect(mockInstanceCount).toBe(countAfterInit + 3);
    expect(mockInstanceBaseUrls.at(-1)).toBeUndefined();
  });
});

describe('CodexPromptService - prompt flow client initialization', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
  });

  it('builds session config, initializes the Codex client, and uses the configured accessor', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-flow.md');
    serviceWithPrivates.buildMcpServersConfig = vi.fn().mockResolvedValue({
      total: 1,
      servers: {
        agor: {
          url: 'http://localhost:3030/mcp',
          default_tools_approval_mode: 'approve',
        },
      },
    });

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-flow',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-flow' as any, 'review')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(mockInstanceCount).toBe(1);
    expect(mockInstanceConfigs).toEqual([
      {
        model_instructions_file: '/tmp/agor-codex-instructions-flow.md',
        mcp_servers: {
          agor: {
            url: 'http://localhost:3030/mcp',
            default_tools_approval_mode: 'approve',
          },
        },
      },
    ]);
    expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
      threadId: 'mock-thread-id',
    });
  });

  it('requires MCP startup from gateway session metadata in the prompt path', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-gateway.md');

    configMocks.getDaemonUrl.mockResolvedValue('http://localhost:3030');
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-gateway',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
      custom_context: { gateway_source: { channel_id: 'channel-1' } },
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    for await (const _event of service.promptSessionStreaming('session-gateway' as any, 'review')) {
      // Drain stream to force client setup.
    }

    expect(mockInstanceConfigs.at(-1)).toMatchObject({
      model_instructions_file: '/tmp/agor-codex-instructions-gateway.md',
      mcp_servers: {
        agor: {
          required: true,
          startup_timeout_ms: 30_000,
        },
        remote: {
          required: true,
          startup_timeout_ms: 30_000,
        },
      },
    });
  });
});

describe('CodexPromptService - forked sessions', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    delete process.env.OPENAI_BASE_URL;
    vi.clearAllMocks();
    appServerMocks.forkCodexThreadViaAppServer.mockReset();
  });

  it('forks the parent Codex thread via app-server before resuming the child thread', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-child.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    const childSession = {
      session_id: 'child-session',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      genealogy: { forked_from_session_id: 'parent-session' },
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    };
    const parentSession = {
      session_id: 'parent-session',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: 'parent-thread-id',
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    };

    mockSessionsRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'child-session') return childSession;
      if (id === 'parent-session') return parentSession;
      return null;
    });
    mockSessionsRepo.update.mockResolvedValue(undefined);
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });
    appServerMocks.forkCodexThreadViaAppServer.mockResolvedValue('forked-thread-id');

    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('child-session' as any, 'continue')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(appServerMocks.forkCodexThreadViaAppServer).toHaveBeenCalledWith(
      'parent-thread-id',
      expect.objectContaining({ env: expect.any(Object) })
    );
    expect(mockSessionsRepo.update).toHaveBeenCalledWith('child-session', {
      sdk_session_id: 'forked-thread-id',
    });
    expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
      threadId: 'forked-thread-id',
    });
  });
});

describe('CodexPromptService - Todo normalization', () => {
  it('maps codex todo_list to TodoWrite-compatible payload with inferred in_progress', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
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
      mockBranchesRepo,
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
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    // Avoid filesystem/config setup noise in this focused stream test
    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
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

describe('CodexPromptService - tool payload mapping', () => {
  it('captures token_count context snapshot and forwards it on turn completion', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-ctx',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: 210000,
            },
            last_token_usage: {
              total_tokens: 12000,
            },
            model_context_window: 272000,
          },
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 500,
          output_tokens: 300,
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-ctx' as any, 'review')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvent = emitted.find((event) => event.type === 'complete');
    expect(completeEvent).toBeTruthy();
    // Snapshot must use last_token_usage (current occupancy = 12_000), NOT
    // total_token_usage (lifetime cumulative = 210_000). Percentage applies
    // Codex CLI's baseline subtraction (12_000 baseline on a 272_000 window):
    // used = max(0, 12_000 - 12_000) = 0  →  0% used.
    expect(completeEvent?.rawContextUsage).toEqual({
      totalTokens: 12000,
      maxTokens: 272000,
      percentage: 0,
    });
  });

  it('falls back to Codex rollout JSONL token_count when SDK stream omits event_msg', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-rollout-ctx',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    try {
      const rolloutDir = path.join(codexHome, 'sessions', '2026', '06', '24');
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, 'rollout-2026-06-24T00-00-00-mock-thread-id.jsonl'),
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 187_135 },
              last_token_usage: { total_tokens: 26_612 },
              model_context_window: 258_400,
            },
          },
        })}
`,
        'utf8'
      );

      mockStreamEvents = [
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 184_792,
            cached_input_tokens: 162_688,
            output_tokens: 2_343,
          },
        },
      ];

      const emitted: Array<Record<string, unknown>> = [];
      for await (const event of service.promptSessionStreaming(
        'session-rollout-ctx' as any,
        'review'
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      const completeEvent = emitted.find((event) => event.type === 'complete');
      expect(completeEvent?.rawContextUsage).toEqual({
        totalTokens: 26_612,
        maxTokens: 258_400,
        percentage: 6,
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not scan rollout JSONL files when the SDK thread id is missing', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-rollout-missing-thread',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-codex-home-'));
    mockStartThreadId = undefined;
    process.env.CODEX_HOME = codexHome;
    try {
      const rolloutDir = path.join(codexHome, 'sessions', '2026', '06', '24');
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, 'rollout-2026-06-24T00-00-00-unrelated-thread.jsonl'),
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { total_tokens: 99_999 },
              model_context_window: 258_400,
            },
          },
        })}
`,
        'utf8'
      );

      mockStreamEvents = [
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1_000,
            cached_input_tokens: 500,
            output_tokens: 300,
          },
        },
      ];

      const emitted: Array<Record<string, unknown>> = [];
      for await (const event of service.promptSessionStreaming(
        'session-rollout-missing-thread' as any,
        'review'
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      const completeEvent = emitted.find((event) => event.type === 'complete');
      expect(completeEvent?.rawContextUsage).toBeUndefined();
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('preserves MCP result content on completion', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'agor',
        tool: 'agor_execute_tool',
        arguments: { tool_name: 'agor_branches_list' },
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structured_content: { success: true },
        },
        status: 'completed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-1',
      name: 'agor.agor_execute_tool',
      input: { tool_name: 'agor_branches_list' },
      output: [{ type: 'text', text: 'ok' }],
      status: 'completed',
    });
  });

  it('preserves MCP error message on failure', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-2',
        type: 'mcp_tool_call',
        server: 'agor',
        tool: 'agor_execute_tool',
        arguments: {},
        error: {
          message: 'permission denied',
        },
        status: 'failed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-2',
      name: 'agor.agor_execute_tool',
      input: {},
      output: 'permission denied',
      status: 'failed',
    });
  });

  it('falls back to structured_content when MCP content blocks are empty', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-structured-only',
        type: 'mcp_tool_call',
        server: 'agor',
        tool: 'agor_execute_tool',
        arguments: { tool_name: 'agor_sessions_get_current' },
        result: {
          content: [],
          structured_content: { session_id: 'abc123', status: 'running' },
        },
        status: 'completed',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'mcp-structured-only',
      name: 'agor.agor_execute_tool',
      input: { tool_name: 'agor_sessions_get_current' },
      output: JSON.stringify({ session_id: 'abc123', status: 'running' }, null, 2),
      status: 'completed',
    });
  });

  it('marks web_search as completed to avoid stale UI status', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'search-1',
        type: 'web_search',
        query: 'openai codex sdk',
      },
      'completed'
    );

    expect(toolUse).toEqual({
      id: 'search-1',
      name: 'web_search',
      input: { query: 'openai codex sdk' },
      status: 'completed',
    });
  });

  it('propagates top-level stream error events (message field) as failures', async () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );

    const serviceWithPrivates = service as any;
    serviceWithPrivates.ensureCodexInstructionsFile = vi
      .fn()
      .mockResolvedValue('/tmp/agor-codex-instructions-mock.md');
    serviceWithPrivates.buildMcpServersConfig = vi
      .fn()
      .mockResolvedValue({ servers: {}, total: 0 });
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: null,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    mockStreamEvents = [{ type: 'error', message: 'stream exploded' }];

    await expect(
      (async () => {
        for await (const _event of service.promptSessionStreaming('session-1' as any, 'review')) {
          // no-op
        }
      })()
    ).rejects.toThrow('Codex stream error: stream exploded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP server config builder
//
// Regression coverage for the fix in this PR: every Codex MCP server config
// Agor emits must carry `default_tools_approval_mode: "approve"`. Without it,
// Codex's elicitation layer prompts for every MCP tool call, and in headless
// `exec --json` mode (what @openai/codex-sdk uses) those prompts resolve to
// "user cancelled MCP tool call". See
// codex-rs/codex-mcp/src/mcp/mod.rs::mcp_permission_prompt_is_auto_approved.
// ─────────────────────────────────────────────────────────────────────────────
describe('CodexPromptService - buildMcpServersConfig', () => {
  const mockMcpServerRepo = {
    findById: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);
    configMocks.getDaemonUrl.mockResolvedValue('http://localhost:3030');
  });

  const makeService = () =>
    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockMcpServerRepo
    );

  it('emits default_tools_approval_mode=approve on the built-in agor server', async () => {
    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'agor-bearer-token',
      undefined
    );

    expect(total).toBe(1);
    expect(servers.agor).toMatchObject({
      url: 'http://localhost:3030/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('emits default_tools_approval_mode=approve on a stdio server', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'xxx' },
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      undefined
    );

    expect(total).toBe(1);
    expect(servers.github).toMatchObject({
      command: 'npx',
      default_tools_approval_mode: 'approve',
    });
  });

  it('emits default_tools_approval_mode=approve on an http/sse server', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      undefined
    );

    expect(total).toBe(1);
    expect(servers.remote).toMatchObject({
      url: 'https://example.com/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('applies default_tools_approval_mode=approve to ALL servers in a mixed config', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
      {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/sse',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'agor-bearer-token',
      undefined
    );

    expect(total).toBe(3);
    for (const name of ['agor', 'github', 'linear']) {
      expect(servers[name], `server "${name}" missing approval mode`).toMatchObject({
        default_tools_approval_mode: 'approve',
      });
    }
  });

  it('marks built-in Agor MCP required for gateway sessions', async () => {
    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'agor-bearer-token',
      undefined,
      true
    );

    expect(total).toBe(1);
    expect(servers.agor).toMatchObject({
      default_tools_approval_mode: 'approve',
      required: true,
      startup_timeout_ms: 30_000,
    });
  });

  it('marks attached MCP servers required for gateway sessions', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
      {
        server: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/sse',
        },
      },
    ]);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      'agor-bearer-token',
      undefined,
      true
    );

    expect(total).toBe(3);
    for (const name of ['agor', 'github', 'linear']) {
      expect(servers[name], `server "${name}" missing startup guard`).toMatchObject({
        required: true,
        startup_timeout_ms: 30_000,
      });
    }
  });

  it('does not require unauthenticated OAuth MCP servers for gateway sessions', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'oauthRemote',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'oauth' },
        },
      },
    ]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      undefined,
      true
    );

    expect(total).toBe(1);
    expect(servers.oauthremote).toMatchObject({
      default_tools_approval_mode: 'approve',
    });
    expect(servers.oauthremote.required).toBeUndefined();
    expect(servers.oauthremote.startup_timeout_ms).toBeUndefined();
  });

  it('does not require remote Bearer or JWT MCP servers without resolved auth', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'bearerRemote',
          transport: 'http',
          url: 'https://bearer.example.com/mcp',
          auth: { type: 'bearer' },
        },
      },
      {
        server: {
          name: 'jwtRemote',
          transport: 'http',
          url: 'https://jwt.example.com/mcp',
          auth: { type: 'jwt' },
        },
      },
    ]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockResolvedValue(null);

    const service = makeService();
    const { servers, total } = await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      undefined,
      true
    );

    expect(total).toBe(2);
    for (const name of ['bearerremote', 'jwtremote']) {
      expect(servers[name], `server "${name}" should remain optional`).toMatchObject({
        default_tools_approval_mode: 'approve',
      });
      expect(servers[name].required).toBeUndefined();
      expect(servers[name].startup_timeout_ms).toBeUndefined();
    }
  });
});
