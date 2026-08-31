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
import type { BranchID, SessionUpdate } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BranchRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';
import type { Message, PermissionMode, SessionID } from '../../types.js';
import type { MessagesService } from '../base/index.js';

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

import { CodexTool } from './codex-tool.js';
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
let mockStreamFailure: Error | undefined;
let mockStartThreadOptions: unknown[] = [];
let mockResumeThreadOptions: unknown[] = [];

async function* streamMockEvents() {
  for (const event of mockStreamEvents) {
    yield event;
  }
  if (mockStreamFailure) throw mockStreamFailure;
}

// Mock the Codex SDK to avoid spawning real Codex CLI processes
vi.mock('./app-server-client.js', () => appServerMocks);
vi.mock('@agor/core/mcp', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/mcp')>('@agor/core/mcp');
  return {
    ...actual,
    ...mcpScopingMocks,
    resolveScopedMCPAuthHeaders: vi.fn(({ server }) =>
      mcpAuthMocks.resolveMCPAuthHeaders(server.auth, server.url)
    ),
  };
});
vi.mock('@agor/core/tools/mcp/jwt-auth', () => mcpAuthMocks);
vi.mock('../../config.js', () => configMocks);

vi.mock('@openai/codex-sdk', () => {
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

    startThread(options: unknown) {
      mockStartThreadOptions.push(options);
      return {
        id: mockStartThreadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }

    resumeThread(threadId: string, options: unknown) {
      mockResumeThreadOptions.push(options);
      return {
        id: threadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: streamMockEvents() }),
      };
    }
  }

  return { Codex: MockCodexClient };
});

// Mock repositories and database
const mockMessagesRepo = {} as any;
const mockSessionsRepo = {
  findById: vi.fn(),
  update: vi.fn(),
} as any;
const mockSessionMCPServerRepo = {
  listServers: vi.fn().mockResolvedValue([]),
  listServersWithMetadata: vi.fn().mockResolvedValue([]),
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
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
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
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
    delete process.env.OPENAI_BASE_URL;
    delete process.env.AGOR_CODEX_SANDBOX_MODE;
    vi.clearAllMocks();
  });

  it.each([
    {
      name: 'persisted allow-all',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'prompt allow-all overriding persisted auto',
      persistedPermissionMode: 'auto',
      promptPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'prompt auto overriding persisted allow-all',
      persistedPermissionMode: 'allow-all',
      promptPermissionMode: 'auto',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'mode-less legacy session using the Codex system default',
      persistedPermissionMode: undefined,
      codexPermissions: {},
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'allow-all with the k8s sandbox override',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      sandboxModeEnvOverride: 'danger-full-access',
      expectedApps: {
        _default: {
          default_tools_approval_mode: 'approve',
        },
      },
    },
    {
      name: 'allow-all with a read-only sandbox environment override',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      sandboxModeEnvOverride: 'read-only',
      expectedApps: undefined,
    },
    {
      name: 'allow-all with network disabled',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: false,
      },
      expectedApps: undefined,
    },
    {
      name: 'allow-all with approval required',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'allow-all with a configured read-only sandbox',
      persistedPermissionMode: 'allow-all',
      codexPermissions: {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
    {
      name: 'persisted auto mode with never approval',
      persistedPermissionMode: 'auto',
      codexPermissions: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccess: true,
      },
      expectedApps: undefined,
    },
  ])(
    'builds policy-enforced session config for $name permissions and uses the configured accessor',
    async ({
      persistedPermissionMode,
      promptPermissionMode,
      codexPermissions,
      sandboxModeEnvOverride,
      expectedApps,
    }) => {
      if (sandboxModeEnvOverride) {
        process.env.AGOR_CODEX_SANDBOX_MODE = sandboxModeEnvOverride;
      }

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
        permission_config: {
          ...(persistedPermissionMode ? { mode: persistedPermissionMode } : {}),
          codex: codexPermissions,
        },
        model_config: { model: 'gpt-5.4', effort: 'medium' },
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
      for await (const event of service.promptSessionStreaming(
        'session-flow' as any,
        'review',
        undefined,
        promptPermissionMode as PermissionMode | undefined
      )) {
        emitted.push(event as Record<string, unknown>);
      }

      expect(mockInstanceCount).toBe(1);
      expect(mockInstanceConfigs).toEqual([
        {
          features: { goals: false, multi_agent: false },
          model_instructions_file: '/tmp/agor-codex-instructions-flow.md',
          mcp_servers: {
            agor: {
              url: 'http://localhost:3030/mcp',
              default_tools_approval_mode: 'approve',
            },
          },
          ...(expectedApps ? { apps: expectedApps } : {}),
        },
      ]);
      expect(emitted.find((event) => event.type === 'complete')).toMatchObject({
        threadId: 'mock-thread-id',
      });
      expect(mockStartThreadOptions.at(-1)).toMatchObject({
        model: 'gpt-5.4',
        modelReasoningEffort: 'medium',
      });
    }
  );

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

  it('owns fresh Codex thread state after clearing a stale thread for new MCP config', async () => {
    const sessionId = 'session-fresh-thread' as SessionID;
    const sessionCreatedAt = new Date('2026-01-01T00:00:00.000Z');
    let storedSdkSessionId: string | undefined = 'stale-thread-id';
    const sessionsRepo = {
      findById: vi.fn(async (_sessionId: SessionID) => ({
        session_id: sessionId,
        branch_id: 'branch-1',
        created_at: sessionCreatedAt.toISOString(),
        last_updated: sessionCreatedAt.toISOString(),
        sdk_session_id: storedSdkSessionId,
        permission_config: { codex: {} },
        model_config: {},
      })),
      update: vi.fn(async (_sessionId: SessionID, patch: SessionUpdate) => {
        if (patch.sdk_session_id === null) storedSdkSessionId = undefined;
        else if (patch.sdk_session_id !== undefined) storedSdkSessionId = patch.sdk_session_id;
        return { sdk_session_id: storedSdkSessionId };
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn(async () => []),
      getNextIndexBySessionId: vi.fn(async (_sessionId: SessionID) => 0),
    };
    const sessionMCPServerRepo = {
      listServersWithMetadata: vi.fn(async (_sessionId: SessionID, _enabledOnly = false) => [
        {
          server: { name: 'new-server' },
          added_at: sessionCreatedAt.getTime() + 60_000,
          enabled: true,
        },
      ]),
    };
    const branchesRepo = {
      findById: vi.fn(async (_branchId: BranchID) => ({ branch_id: 'branch-1' })),
    };
    const messagesService = {
      create: vi.fn(async (message: Partial<Message>) => message as Message),
      patch: vi.fn(async (_messageId: string, message: Partial<Message>) => message as Message),
    } satisfies MessagesService;
    const tool = new CodexTool(
      messagesRepo as unknown as MessagesRepository,
      sessionsRepo as unknown as SessionRepository,
      sessionMCPServerRepo as unknown as SessionMCPServerRepository,
      branchesRepo as unknown as BranchRepository,
      undefined,
      'test-api-key',
      messagesService
    );
    const previousStreamEvents = mockStreamEvents;
    const previousStartThreadId = mockStartThreadId;
    const previousStreamFailure = mockStreamFailure;
    mockStartThreadId = 'fresh-thread-id';
    mockStreamFailure = undefined;
    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    try {
      await mcpScopingMocks.getMcpServersForSession.withImplementation(
        vi.fn().mockResolvedValue([]),
        async () => {
          await expect(
            tool.executePromptWithStreaming(sessionId, 'continue')
          ).resolves.toBeDefined();

          expect(sessionsRepo.update).toHaveBeenNthCalledWith(1, sessionId, {
            sdk_session_id: null,
          });
          expect(sessionsRepo.update).toHaveBeenNthCalledWith(2, sessionId, {
            sdk_session_id: 'fresh-thread-id',
          });
          expect(storedSdkSessionId).toBe('fresh-thread-id');

          storedSdkSessionId = 'stale-thread-id';
          sessionsRepo.update.mockClear();
          mockStreamEvents = [
            {
              type: 'item.completed',
              item: { id: 'message-1', type: 'agent_message', text: 'Progress.' },
            },
          ];
          mockStreamFailure = new Error('event iterator failed after thread capture');

          await expect(tool.executePromptWithStreaming(sessionId, 'continue')).rejects.toThrow(
            'The Codex turn was interrupted before completion. Retry the prompt.'
          );
        }
      );

      expect(sessionsRepo.update).toHaveBeenNthCalledWith(1, sessionId, {
        sdk_session_id: null,
      });
      expect(sessionsRepo.update).toHaveBeenNthCalledWith(2, sessionId, {
        sdk_session_id: 'fresh-thread-id',
      });
      expect(sessionsRepo.update).toHaveBeenNthCalledWith(3, sessionId, {
        sdk_session_id: null,
      });
      expect(storedSdkSessionId).toBeUndefined();
    } finally {
      mockStreamEvents = previousStreamEvents;
      mockStartThreadId = previousStartThreadId;
      mockStreamFailure = previousStreamFailure;
      await fs.rm(path.join(os.tmpdir(), 'agor-codex-instructions-session-fresh-thread.md'), {
        force: true,
      });
    }
  });
});

describe('CodexPromptService - forked sessions', () => {
  beforeEach(() => {
    mockInstanceCount = 0;
    mockInstanceBaseUrls = [];
    mockInstanceConfigs = [];
    mockClosedInstanceIds = [];
    mockStreamEvents = [];
    mockStartThreadOptions = [];
    mockResumeThreadOptions = [];
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
      model_config: { effort: 'max' },
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
    expect(mockResumeThreadOptions.at(-1)).toMatchObject({
      modelReasoningEffort: 'max',
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

  it('sanitizes MCP provider error messages on failure', () => {
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
      output:
        'The MCP operation failed. Retry, then ask an administrator to review the secure operational event if it continues.',
      status: 'failed',
    });
  });

  it('does not invoke or retain hostile MCP error metadata getters', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockBranchesRepo,
      undefined,
      'test-api-key',
      mockDb
    );
    const sentinel = 'SENTINEL_CODEX_METADATA_GETTER';
    const providerError = new Error(sentinel);
    Object.defineProperties(providerError, {
      code: {
        get() {
          throw new Error(sentinel);
        },
      },
      name: {
        get() {
          throw new Error(sentinel);
        },
      },
    });

    const toolUse = (service as any).itemToToolUse(
      {
        id: 'mcp-hostile',
        type: 'mcp_tool_call',
        server: 'agor',
        tool: 'agor_execute_tool',
        arguments: {},
        error: providerError,
        status: 'failed',
      },
      'completed'
    );

    expect(JSON.stringify(toolUse)).not.toContain(sentinel);
    expect(toolUse.output).toContain('The MCP operation failed');
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

  it('clears resume state on a fatal stream error even when the session started fresh', async () => {
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
    ).rejects.toThrow('The MCP operation failed');

    expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
      sdk_session_id: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// event_msg terminal handling (issue #1749)
//
// New Codex rollout format emits terminal completion via `event_msg` payloads
// with payload.type === "agent_message" or "task_complete" instead of the SDK
// event turn.completed. Without handling these, the adapter left the task
// running until the daemon safety-net (~15 min later) marked it failed.
// ─────────────────────────────────────────────────────────────────────────────
describe('CodexPromptService - event_msg terminal handling (issue #1749)', () => {
  type CodexPromptServiceTestHarness = CodexPromptService & {
    ensureCodexClient(config: { model_instructions_file: string }): Promise<void>;
    refreshClient(apiKey: string): void;
    codex: {
      startThread: (...args: never[]) => unknown;
      resumeThread: (...args: never[]) => unknown;
    };
  };

  const testSessionId = 'session-1' as SessionID;

  function makeStreamingService(sdkSessionId: string | null = null) {
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

    mockSessionsRepo.findById.mockResolvedValue({
      session_id: 'session-1',
      branch_id: 'branch-1',
      created_at: new Date().toISOString(),
      sdk_session_id: sdkSessionId,
      permission_config: { codex: {} },
      model_config: {},
      mcp_token: 'test-token',
    });
    mockBranchesRepo.findById.mockResolvedValue({
      branch_id: 'branch-1',
      path: process.cwd(),
    });

    return service;
  }

  async function makeInitializedStreamingService(sdkSessionId: string | null = null) {
    const service = makeStreamingService(sdkSessionId);
    const internals = service as unknown as CodexPromptServiceTestHarness;
    await internals.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    internals.ensureCodexClient = vi.fn(async () => {});
    internals.refreshClient = vi.fn();
    return { service, codex: internals.codex };
  }

  async function drain(service: CodexPromptService, abortController?: AbortController) {
    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming(
      testSessionId,
      'go',
      undefined,
      undefined,
      abortController
    )) {
      emitted.push(event as Record<string, unknown>);
    }
    return emitted;
  }

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

  it('projects turn completion accounting without raw SDK extension metadata', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    const sentinel = 'SENTINEL_CODEX_COMPLETION_METADATA';
    mockStreamEvents = [
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 8,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
        metadata: { exception: new Error(sentinel) },
      },
    ];

    const completed = (await drain(service)).find((event) => event.type === 'complete');

    expect(completed?.rawSdkEvent).toEqual({
      type: 'turn.completed',
      usage: {
        input_tokens: 8,
        cached_input_tokens: 2,
        output_tokens: 3,
        reasoning_output_tokens: 1,
      },
    });
    expect(JSON.stringify(completed)).not.toContain(sentinel);
  });

  it('surfaces event_msg agent_message via the actual "message" field (real rollout shape)', async () => {
    // Actual payload shape from failed-run logs:
    //   { type: "agent_message", message: "...", phase: "...", memory_citation: ... }
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'All changes have been applied.',
          phase: 'completed',
          memory_citation: null,
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const textBlocks = emitted.filter(
      (e) =>
        e.type === 'complete' &&
        Array.isArray(e.content) &&
        (e.content as Array<{ type: string; text?: string }>).some(
          (c) => c.type === 'text' && c.text === 'All changes have been applied.'
        )
    );
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('treats event_msg task_complete (real rollout shape) as terminal success', async () => {
    // Actual payload shape from failed-run logs:
    //   { type: "task_complete", turn_id: "...", last_agent_message: "...",
    //     duration_ms: 900000, time_to_first_token_ms: 1234, completed_at: "..." }
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'echo hi',
          aggregated_output: 'hi\n',
          status: 'success',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-abc123',
          last_agent_message: 'Done. The script ran successfully.',
          duration_ms: 900000,
          time_to_first_token_ms: 1234,
          completed_at: '2026-07-01T13:00:00Z',
        },
      },
      // No turn.completed — this is the new rollout format.
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvents = emitted.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);

    const last = completeEvents.at(-1);
    expect(last?.threadId).toBe('mock-thread-id');

    // last_agent_message must appear in content when no prior agent_message pushed text
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(
      content.some((c) => c.type === 'text' && c.text === 'Done. The script ran successfully.')
    ).toBe(true);
  });

  it('treats event_msg turn_complete alias as terminal success', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'turn_complete',
          turn_id: 'turn-v2',
          last_agent_message: 'Done via turn_complete.',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(content.some((c) => c.type === 'text' && c.text === 'Done via turn_complete.')).toBe(
      true
    );
  });

  it('uses last_agent_message from task_complete when no prior agent_message event provided text', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-xyz',
          last_agent_message: 'Task completed successfully.',
          duration_ms: 12000,
          time_to_first_token_ms: 500,
          completed_at: '2026-07-01T13:00:05Z',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = last?.content as Array<{ type: string; text?: string }>;
    expect(
      content.some((c) => c.type === 'text' && c.text === 'Task completed successfully.')
    ).toBe(true);
  });

  it('does not duplicate text when agent_message already pushed the same content before task_complete', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    const finalText = 'All done!';

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        // agent_message pushes the text first
        payload: { type: 'agent_message', message: finalText, phase: 'completed' },
      },
      {
        type: 'event_msg',
        // task_complete carries the same text in last_agent_message
        payload: {
          type: 'task_complete',
          turn_id: 'turn-dup',
          last_agent_message: finalText,
          duration_ms: 5000,
          time_to_first_token_ms: 200,
          completed_at: '2026-07-01T13:00:10Z',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const completeEvents = emitted.filter((e) => e.type === 'complete');
    expect(completeEvents).toHaveLength(1);

    const finalComplete = completeEvents.at(-1);
    const content = finalComplete?.content as Array<{ type: string; text?: string }>;
    // There should be exactly one text block with finalText, not two.
    const textOccurrences = content.filter((c) => c.type === 'text' && c.text === finalText);
    expect(textOccurrences).toHaveLength(1);
  });

  it('preserves distinct agent_message and last_agent_message text blocks', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Progress update.', phase: 'running' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-final',
          last_agent_message: 'Final answer.',
        },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const finalComplete = emitted.filter((e) => e.type === 'complete').at(-1);
    const content = finalComplete?.content as Array<{ type: string; text?: string }>;
    expect(content.filter((c) => c.type === 'text').map((c) => c.text)).toEqual([
      'Progress update.',
      'Final answer.',
    ]);
  });

  it('carries event_msg token_count context snapshot into the task_complete complete event', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 30_000 },
            model_context_window: 272_000,
          },
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    const last = emitted.filter((e) => e.type === 'complete').at(-1);
    expect(last?.rawContextUsage).toMatchObject({
      totalTokens: 30_000,
      maxTokens: 272_000,
    });
  });

  it('treats the SDK-defined fatal error event as authoritative without parsing reconnect prose', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');

    const reconnectMessage =
      'Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)';
    mockStreamEvents = [
      { type: 'error', message: reconnectMessage },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];
    await expect(drain(service)).rejects.toThrow('The MCP operation failed');
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['fresh', null],
    ['established', 'existing-thread-id'],
  ])(
    'classifies a real SDK-shaped turn.failed as unknown for a %s thread',
    async (_threadKind, sdkSessionId) => {
      const { service } = await makeInitializedStreamingService(sdkSessionId);

      mockStreamEvents = [
        { type: 'turn.failed', error: { message: 'provider rejected the turn' } },
      ];

      await expect(drain(service)).rejects.toThrow('The MCP operation failed');

      expect(mockSessionsRepo.update).not.toHaveBeenCalled();
    }
  );

  it('never logs or returns a secret-bearing runtime provider exception', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    const sentinel = 'SENTINEL_CODEX_RUNTIME_PROVIDER_4e2b';
    mockStreamEvents = [
      {
        type: 'turn.failed',
        error: { message: `TLS failure for https://${sentinel}.example.test` },
      },
    ];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    try {
      const failure = await drain(service).catch((error: unknown) => error);
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(sentinel);
      expect(JSON.stringify(mockSessionsRepo.update.mock.calls)).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not claim reauthentication authority from arbitrary ThreadError prose', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    mockStreamEvents = [
      {
        type: 'turn.failed',
        error: { message: 'provider_rejected SENTINEL_REJECTED_BODY' },
      },
    ];

    const failure = await drain(service).catch((error: unknown) => error);
    expect(String(failure)).toContain('The MCP operation failed');
    expect(String(failure)).not.toContain('SENTINEL_REJECTED_BODY');
    expect(String(failure)).not.toContain('sign in again');
  });

  it('reports missing local Codex authentication as configuration required', async () => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');
    (service as any).apiKey = '';
    (service as any).useNativeAuth = false;
    mockStreamEvents = [
      { type: 'turn.failed', error: { message: 'SENTINEL_MISSING_AUTH_PROVIDER_BODY' } },
    ];

    await expect(drain(service)).rejects.toThrow(
      'This MCP authentication configuration is incomplete. Review the saved server settings and retry.'
    );
  });

  it.each([
    ['reconnecting... 2/5', 'lowercase'],
    ['Reconnecting...', 'missing N/M'],
    [' Reconnecting... 2/5', 'leading whitespace'],
    ['Error: Reconnecting... 2/5', 'prefixed text'],
  ])('treats %s as a fatal stream error (%s)', async (message) => {
    const { service } = await makeInitializedStreamingService('existing-thread-id');

    mockStreamEvents = [{ type: 'error', message }];

    await expect(drain(service)).rejects.toThrow('The MCP operation failed');

    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['fresh', null],
    ['established', 'existing-thread-id'],
  ])(
    'throws on pre-terminal EOF and only clears a %s thread invocation',
    async (_threadKind, sdkSessionId) => {
      const { service } = await makeInitializedStreamingService(sdkSessionId);

      // Stream ends with no terminal event — simulates process exit with code 0
      mockStreamEvents = [
        { type: 'turn.started' },
        { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls' } },
        // Stream just ends — no turn.completed, turn.failed, task_complete, or error
      ];

      await expect(drain(service)).rejects.toThrow(
        'Codex ended the turn without a completion event'
      );

      if (sdkSessionId === null) {
        expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
          sdk_session_id: null,
        });
      } else {
        expect(mockSessionsRepo.update).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['before event iteration', null],
    ['before event iteration', 'existing-thread-id'],
    ['while iterating events', null],
    ['while iterating events', 'existing-thread-id'],
  ])(
    'only clears fresh thread state when transport fails %s (sdk_session_id=%s)',
    async (failurePoint, sdkSessionId) => {
      const { service, codex } = await makeInitializedStreamingService(sdkSessionId);

      const thread = {
        id: sdkSessionId ?? 'fresh-thread-id',
        run: vi.fn(),
        runStreamed:
          failurePoint === 'before event iteration'
            ? vi.fn().mockRejectedValue(new Error('runStreamed aborted unexpectedly'))
            : vi.fn().mockResolvedValue({
                events: (async function* () {
                  yield { type: 'turn.started' };
                  throw new Error('event iterator failed');
                })(),
              }),
      };
      if (sdkSessionId) {
        codex.resumeThread = vi.fn(() => thread);
      } else {
        codex.startThread = vi.fn(() => thread);
      }

      await expect(drain(service)).rejects.toThrow(
        failurePoint === 'before event iteration'
          ? 'Codex could not start the turn. Retry the prompt.'
          : 'The Codex turn was interrupted before completion. Retry the prompt.'
      );

      if (sdkSessionId === null) {
        expect(mockSessionsRepo.update).toHaveBeenCalledWith('session-1', {
          sdk_session_id: null,
        });
      } else {
        expect(mockSessionsRepo.update).not.toHaveBeenCalled();
      }
    }
  );

  it('treats an actually aborted controller as stopped and preserves the established thread', async () => {
    const { service, codex } = await makeInitializedStreamingService('existing-thread-id');
    const abortController = new AbortController();
    abortController.abort();
    codex.resumeThread = vi.fn(() => ({
      id: 'existing-thread-id',
      run: vi.fn(),
      runStreamed: vi.fn().mockRejectedValue(new Error('transport failed after cancellation')),
    }));

    const emitted = await drain(service, abortController);

    expect(emitted).toContainEqual({
      type: 'stopped',
      threadId: 'existing-thread-id',
    });
    expect(mockSessionsRepo.update).not.toHaveBeenCalled();
  });

  it('does not throw when stream ends after a user-requested stop', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    // The service clears stale stop flags before streaming starts, so calling
    // stopTask() before promptSessionStreaming() has no effect. Instead, we
    // override the mock Codex thread to signal the stop mid-stream (between
    // yields) — the same ordering that occurs in production when the UI calls
    // stopTask() while events are streaming.
    const mockCodexClient = serviceWithPrivates.codex;
    mockCodexClient.startThread = vi.fn(() => ({
      id: 'mock-thread-id',
      run: vi.fn(),
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.started' };
          // Signal stop after the first event — before the next event is
          // processed the for-await loop will check stopRequested and break.
          service.stopTask('session-1' as any);
          yield {
            type: 'item.started',
            item: { id: 'x', type: 'command_execution', command: 'ls' },
          };
          // This event is never reached because the stop check fires first.
          yield { type: 'turn.completed', usage: {} };
        })(),
      }),
    }));

    const emitted: Array<Record<string, unknown>> = [];
    await expect(
      (async () => {
        for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
          emitted.push(event as Record<string, unknown>);
        }
      })()
    ).resolves.toBeUndefined();

    expect(emitted.some((e) => e.type === 'stopped')).toBe(true);
  });

  it('ignores unknown event_msg payload types without throwing', async () => {
    const service = makeStreamingService();
    const serviceWithPrivates = service as any;
    await serviceWithPrivates.ensureCodexClient({
      model_instructions_file: '/tmp/agor-codex-instructions-mock.md',
    });
    serviceWithPrivates.ensureCodexClient = vi.fn();
    serviceWithPrivates.refreshClient = vi.fn();

    mockStreamEvents = [
      { type: 'turn.started' },
      { type: 'event_msg', payload: { type: 'some_future_payload_type', data: {} } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
      },
    ];

    const emitted: Array<Record<string, unknown>> = [];
    for await (const event of service.promptSessionStreaming('session-1' as any, 'go')) {
      emitted.push(event as Record<string, unknown>);
    }

    expect(emitted.some((e) => e.type === 'complete')).toBe(true);
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
  const sessionOwnerId = '019e3700-owner-owner-owner-owner000001';
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
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.agor).toMatchObject({
      url: 'http://localhost:3030/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('passes forUserId to shared MCP scoping for per-user OAuth injection', async () => {
    const service = makeService();

    await (service as any).buildMcpServersConfig(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      undefined,
      {
        forUserId: '019e3700-user-user-user-user00000001',
        sessionOwnerId,
      }
    );

    expect(mcpScopingMocks.getMcpServersForSession).toHaveBeenCalledWith(
      '019e3700-aaaa-bbbb-cccc-dddddddddddd',
      expect.objectContaining({
        forUserId: '019e3700-user-user-user-user00000001',
      }),
      // Codex can drop individual tools but has no way to prompt.
      { toolFiltering: 'exclude' }
    );
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
      { sessionOwnerId }
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
      { sessionOwnerId }
    );

    expect(total).toBe(1);
    expect(servers.remote).toMatchObject({
      url: 'https://example.com/mcp',
      default_tools_approval_mode: 'approve',
    });
  });

  it('never logs a resolved remote URL even when Codex MCP debugging is enabled', async () => {
    const secretUrl = 'https://example.test/mcp?credential=do-not-log';
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'remote-secret-url',
          transport: 'http',
          url: secretUrl,
        },
      },
    ]);
    const previous = process.env.AGOR_DEBUG_CODEX;
    process.env.AGOR_DEBUG_CODEX = '1';
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      await (makeService() as any).buildMcpServersConfig(
        '019e3700-aaaa-bbbb-cccc-dddddddddddd',
        undefined,
        { sessionOwnerId }
      );
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secretUrl);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('do-not-log');
    } finally {
      debug.mockRestore();
      if (previous === undefined) delete process.env.AGOR_DEBUG_CODEX;
      else process.env.AGOR_DEBUG_CODEX = previous;
    }
  });

  it('never logs secret-bearing auth resolution exceptions', async () => {
    const sentinel = 'SENTINEL_AUTH_EXCEPTION_3c90';
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          mcp_server_id: '01900000-0000-7000-8000-000000000091',
          name: 'remote-auth-error',
          transport: 'http',
          url: 'https://example.test/mcp',
          auth: { type: 'bearer', token: 'configured' },
        },
      },
    ]);
    mcpAuthMocks.resolveMCPAuthHeaders.mockRejectedValueOnce(
      new Error(`provider endpoint included ${sentinel}`)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await (makeService() as any).buildMcpServersConfig(
        '019e3700-aaaa-bbbb-cccc-dddddddddddd',
        undefined,
        { sessionOwnerId }
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'executor=codex servers=1 credential_unavailable=0 resolution_failed=1'
        )
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('passes custom HTTP headers through Codex env_http_headers without inlining secrets', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'userguiding',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'none' },
          headers: {
            'X-API-Key': 'secret-api-key',
            'X-Workspace': 'workspace-123',
          },
        },
      },
    ]);

    const service = makeService();
    try {
      const { servers, total } = await (service as any).buildMcpServersConfig(
        '019e3700-aaaa-bbbb-cccc-dddddddddddd',
        undefined,
        { sessionOwnerId }
      );

      expect(total).toBe(1);
      expect(servers.userguiding).toMatchObject({
        url: 'https://example.com/mcp',
        env_http_headers: {
          'X-API-Key': 'AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1',
          'X-Workspace': 'AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2',
        },
      });
      expect(servers.userguiding).not.toHaveProperty('headers');
      expect(servers.userguiding).not.toHaveProperty('http_headers');
      expect(process.env.AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1).toBe(
        'secret-api-key'
      );
      expect(process.env.AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2).toBe(
        'workspace-123'
      );
    } finally {
      delete process.env.AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_1;
      delete process.env.AGOR_MCP_019e3700aaaabbbbccccdddd_USERGUIDING_HEADER_2;
    }
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
      { sessionOwnerId }
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
      { sessionOwnerId, requireMcpServers: true }
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
      { sessionOwnerId, requireMcpServers: true }
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
      { sessionOwnerId, requireMcpServers: true }
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
      { sessionOwnerId, requireMcpServers: true }
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

// ─────────────────────────────────────────────────────────────────────────────
// MCP `tool_permissions` enforcement
//
// `disabled_tools` is the ONLY thing standing between the model and a switched-
// off tool on Codex. Every block above asserts Agor also emits
// `default_tools_approval_mode: "approve"`, which auto-approves every MCP tool
// call — so there is no prompt to fall back on, and no `canUseTool` equivalent:
// Codex resolves the config in native code and Agor never sees the call.
//
// That makes an omission here silent and total. It is also easy to introduce:
// the config is assembled in two separate transport branches, and the HTTP one
// carries essentially every marketplace server (the catalog is remote
// endpoints), so a `disabled_tools` line dropped from that branch alone would
// leave stdio coverage intact and look fine.
//
// These cases therefore drive the real `buildMcpServersConfig` per transport.
// The rest of the suite stubs that method out, which is exactly why this was
// uncovered. Each case pairs the denied tool with an allowed one, so a passing
// assertion means the filter is selective rather than empty or total.
// ─────────────────────────────────────────────────────────────────────────────
describe('CodexPromptService - MCP tool_permissions', () => {
  const sessionOwnerId = '019e3700-owner-owner-owner-owner000001';
  const sessionId = '019e3700-aaaa-bbbb-cccc-dddddddddddd';
  const mockMcpServerRepo = { findById: vi.fn() } as any;

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

  const build = async () =>
    (await (makeService() as any).buildMcpServersConfig(sessionId, undefined, {
      sessionOwnerId,
    })) as { servers: Record<string, any>; total: number };

  /** Same server, same permissions, addressed over each transport Codex accepts. */
  const gatedServer = (transport: 'stdio' | 'http' | 'sse') => ({
    server: {
      name: 'sentry',
      transport,
      ...(transport === 'stdio'
        ? { command: 'npx', args: ['-y', 'sentry-mcp'] }
        : { url: 'https://mcp.sentry.dev/mcp' }),
      tool_permissions: { delete_project: 'deny', list_issues: 'allow' },
    },
  });

  for (const transport of ['stdio', 'http', 'sse'] as const) {
    it(`disables a denied tool on a ${transport} server, leaving allowed tools reachable`, async () => {
      mcpScopingMocks.getMcpServersForSession.mockResolvedValue([gatedServer(transport)]);

      const { servers } = await build();

      expect(servers.sentry.disabled_tools).toEqual(['delete_project']);
      expect(servers.sentry.disabled_tools).not.toContain('list_issues');
      // The gate has to coexist with the auto-approval that makes it load-bearing.
      expect(servers.sentry.default_tools_approval_mode).toBe('approve');
    });
  }

  it('fails closed on "ask", because Codex runs headless with no approval channel', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'sentry',
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          tool_permissions: { update_issue: 'ask', list_issues: 'allow' },
        },
      },
    ]);

    const { servers } = await build();

    // An unanswerable "ask" must collapse onto deny, never onto allow.
    expect(servers.sentry.disabled_tools).toEqual(['update_issue']);
  });

  it('leaves disabled_tools unset when a server gates nothing', async () => {
    mcpScopingMocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'sentry',
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          tool_permissions: { list_issues: 'allow' },
        },
      },
    ]);

    const { servers } = await build();

    // Guards the other direction: an empty list must not be emitted as a filter
    // Codex could read as "disable everything", and must not appear as noise.
    expect(servers.sentry.disabled_tools).toBeUndefined();
  });
});
