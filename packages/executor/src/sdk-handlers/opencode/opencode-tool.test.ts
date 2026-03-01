/**
 * OpenCodeTool Tests
 *
 * Tests for:
 * - Directory-scoped client caching
 * - MCP server injection (Agor + user-defined)
 * - Session context management (worktree path, MCP token)
 * - Capabilities reflecting MCP support
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeTool } from './opencode-tool.js';

// Track client creation calls
let clientCreateCount = 0;
const createdClients: Array<{ baseUrl: string; directory?: string }> = [];

// Mock MCP add calls per client
const mockMcpAddCalls: Array<{ name: string; config: unknown }> = [];

// Create a mock client factory
function createMockClient(opts: { baseUrl: string; directory?: string }) {
  clientCreateCount++;
  createdClients.push(opts);

  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { id: 'mock-session-id' } }),
      get: vi.fn().mockResolvedValue({ data: {} }),
      prompt: vi.fn().mockResolvedValue({ data: { parts: [], info: {} } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: [] }),
    },
    mcp: {
      add: vi
        .fn()
        .mockImplementation(async (params: { body: { name: string; config: unknown } }) => {
          mockMcpAddCalls.push({ name: params.body.name, config: params.body.config });
          return { data: {} };
        }),
    },
  };
}

// Mock @opencode-ai/sdk
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: (config: { baseUrl: string; directory?: string }) =>
    createMockClient(config),
}));

// Mock getDaemonUrl
vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn().mockResolvedValue('http://localhost:3030'),
}));

// Mock MCP scoping
vi.mock('../base/mcp-scoping.js', () => ({
  getMcpServersForSession: vi.fn().mockResolvedValue([]),
}));

// Mock repositories
const mockMessagesService = {
  create: vi.fn().mockResolvedValue({ message_id: 'mock-msg-id' }),
} as any;

const mockSessionMCPRepo = {
  listServers: vi.fn().mockResolvedValue([]),
} as any;

const mockMCPServerRepo = {
  findAll: vi.fn().mockResolvedValue([]),
} as any;

describe('OpenCodeTool', () => {
  beforeEach(() => {
    clientCreateCount = 0;
    createdClients.length = 0;
    mockMcpAddCalls.length = 0;
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should accept MCP repository dependencies', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      expect(tool).toBeDefined();
      expect(tool.toolType).toBe('opencode');
      expect(tool.name).toBe('OpenCode');
    });

    it('should work without optional MCP repos (backward compat)', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      expect(tool).toBeDefined();
    });
  });

  describe('Capabilities', () => {
    it('should report supportsChildSpawn as true (via Agor MCP)', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const caps = tool.getCapabilities();
      expect(caps.supportsChildSpawn).toBe(true);
    });

    it('should report all expected capabilities', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const caps = tool.getCapabilities();
      expect(caps.supportsSessionCreate).toBe(true);
      expect(caps.supportsLiveExecution).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsSessionImport).toBe(false);
      expect(caps.supportsSessionFork).toBe(false);
      expect(caps.supportsGitState).toBe(false);
    });
  });

  describe('Session Context', () => {
    it('should store and retrieve session context with worktree path and MCP token', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      tool.setSessionContext(
        'agor-session-1',
        'opencode-session-1',
        'claude-sonnet-4-5',
        'anthropic',
        '/path/to/worktree',
        'mcp-token-abc'
      );

      // Access private method via type assertion
      const ctx = (tool as any).getSessionContext('agor-session-1');
      expect(ctx).toBeDefined();
      expect(ctx.opencodeSessionId).toBe('opencode-session-1');
      expect(ctx.model).toBe('claude-sonnet-4-5');
      expect(ctx.provider).toBe('anthropic');
      expect(ctx.worktreePath).toBe('/path/to/worktree');
      expect(ctx.mcpToken).toBe('mcp-token-abc');
    });

    it('should handle missing optional fields', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      tool.setSessionContext('agor-session-2', 'opencode-session-2');

      const ctx = (tool as any).getSessionContext('agor-session-2');
      expect(ctx).toBeDefined();
      expect(ctx.opencodeSessionId).toBe('opencode-session-2');
      expect(ctx.model).toBeUndefined();
      expect(ctx.provider).toBeUndefined();
      expect(ctx.worktreePath).toBeUndefined();
      expect(ctx.mcpToken).toBeUndefined();
    });

    it('should return undefined for unknown session', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const ctx = (tool as any).getSessionContext('nonexistent');
      expect(ctx).toBeUndefined();
    });
  });

  describe('Directory-Scoped Client Caching', () => {
    it('should create default client when no directory provided', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const client1 = (tool as any).getClientForDirectory(undefined);
      expect(clientCreateCount).toBe(1);
      expect(createdClients[0].baseUrl).toBe('http://localhost:4096');
      expect(createdClients[0].directory).toBeUndefined();

      // Same call should reuse cached client
      const client2 = (tool as any).getClientForDirectory(undefined);
      expect(clientCreateCount).toBe(1); // Still 1 - reused
      expect(client1).toBe(client2);
    });

    it('should create directory-scoped client with directory option', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      (tool as any).getClientForDirectory('/path/to/worktree');
      expect(clientCreateCount).toBe(1);
      expect(createdClients[0].directory).toBe('/path/to/worktree');
    });

    it('should cache directory-scoped clients by path', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const client1 = (tool as any).getClientForDirectory('/path/a');
      const client2 = (tool as any).getClientForDirectory('/path/a');

      expect(clientCreateCount).toBe(1); // Reused
      expect(client1).toBe(client2);
    });

    it('should create separate clients for different directories', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      (tool as any).getClientForDirectory('/path/a');
      (tool as any).getClientForDirectory('/path/b');

      expect(clientCreateCount).toBe(2);
      expect(createdClients[0].directory).toBe('/path/a');
      expect(createdClients[1].directory).toBe('/path/b');
    });

    it('should keep default and directory clients separate', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const defaultClient = (tool as any).getClientForDirectory(undefined);
      const dirClient = (tool as any).getClientForDirectory('/path/a');

      expect(clientCreateCount).toBe(2);
      expect(defaultClient).not.toBe(dirClient);
    });

    it('getClient() should delegate to getClientForDirectory(undefined)', () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      const fromGetClient = (tool as any).getClient();
      const fromGetClientForDir = (tool as any).getClientForDirectory(undefined);

      expect(fromGetClient).toBe(fromGetClientForDir);
      expect(clientCreateCount).toBe(1); // Same client reused
    });
  });

  describe('MCP Server Injection', () => {
    it('should inject Agor MCP server when mcpToken is provided', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);

      await (tool as any).ensureMcpServers('session-1', client, 'test-token');

      // Should have called client.mcp.add with Agor MCP config
      expect(mockMcpAddCalls.length).toBeGreaterThanOrEqual(1);
      const agorCall = mockMcpAddCalls.find((c) => c.name === 'agor');
      expect(agorCall).toBeDefined();
      expect(agorCall!.config).toEqual({
        type: 'remote',
        url: 'http://localhost:3030/mcp?sessionToken=test-token',
        enabled: true,
      });
    });

    it('should NOT inject Agor MCP server when mcpToken is undefined', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);

      await (tool as any).ensureMcpServers('session-1', client, undefined);

      // Should NOT have injected Agor MCP
      const agorCall = mockMcpAddCalls.find((c) => c.name === 'agor');
      expect(agorCall).toBeUndefined();
    });

    it('should skip re-injection when config hash unchanged', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);

      // First call
      await (tool as any).ensureMcpServers('session-1', client, 'token-1');
      const callsAfterFirst = mockMcpAddCalls.length;

      // Second call with same config - should skip
      await (tool as any).ensureMcpServers('session-1', client, 'token-1');
      expect(mockMcpAddCalls.length).toBe(callsAfterFirst); // No new calls
    });

    it('should re-inject when config hash changes', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);

      // First call
      await (tool as any).ensureMcpServers('session-1', client, 'token-1');
      const callsAfterFirst = mockMcpAddCalls.length;

      // Second call with different token - should re-inject
      await (tool as any).ensureMcpServers('session-1', client, 'token-2');
      expect(mockMcpAddCalls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('should inject user-defined MCP servers via getMcpServersForSession', async () => {
      // Import the mock to control its return value
      const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
      const mockGetMcp = vi.mocked(getMcpServersForSession);

      // Set up mock to return user-defined servers
      mockGetMcp.mockResolvedValueOnce([
        {
          server: {
            mcp_server_id: 'server-1',
            name: 'My Custom MCP',
            transport: 'stdio',
            command: '/usr/bin/node',
            args: ['server.js'],
            env: { NODE_ENV: 'production' },
            scope: 'global',
            enabled: true,
          } as any,
          source: 'global',
        },
        {
          server: {
            mcp_server_id: 'server-2',
            name: 'Remote API',
            transport: 'http',
            url: 'https://api.example.com/mcp',
            auth: { token: 'bearer-token' },
            scope: 'session',
            enabled: true,
          } as any,
          source: 'session-assigned',
        },
      ]);

      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);

      await (tool as any).ensureMcpServers('session-1', client, 'test-token');

      // Should have called getMcpServersForSession
      expect(mockGetMcp).toHaveBeenCalledWith('session-1', {
        sessionMCPRepo: mockSessionMCPRepo,
        mcpServerRepo: mockMCPServerRepo,
      });

      // Should have injected stdio server as local
      const stdioCall = mockMcpAddCalls.find((c) => c.name === 'my_custom_mcp');
      expect(stdioCall).toBeDefined();
      expect(stdioCall!.config).toEqual({
        type: 'local',
        command: ['/usr/bin/node', 'server.js'],
        environment: { NODE_ENV: 'production' },
        enabled: true,
      });

      // Should have injected http server as remote
      const httpCall = mockMcpAddCalls.find((c) => c.name === 'remote_api');
      expect(httpCall).toBeDefined();
      expect(httpCall!.config).toEqual({
        type: 'remote',
        url: 'https://api.example.com/mcp',
        enabled: true,
        headers: { Authorization: 'Bearer bearer-token' },
      });
    });

    it('should sanitize MCP server names to lowercase alphanumeric', async () => {
      const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
      const mockGetMcp = vi.mocked(getMcpServersForSession);

      mockGetMcp.mockResolvedValueOnce([
        {
          server: {
            mcp_server_id: 'server-1',
            name: 'My Custom MCP Server!',
            transport: 'sse',
            url: 'https://example.com/sse',
            scope: 'global',
            enabled: true,
          } as any,
          source: 'global',
        },
      ]);

      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);
      await (tool as any).ensureMcpServers('session-sanitize', client, 'token');

      // Name should be sanitized: "My Custom MCP Server!" -> "my_custom_mcp_server_"
      const call = mockMcpAddCalls.find((c) => c.name === 'my_custom_mcp_server_');
      expect(call).toBeDefined();
    });

    it('should handle MCP injection errors gracefully', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      // Create a client whose mcp.add throws
      const client = (tool as any).getClientForDirectory(undefined);
      client.mcp.add = vi.fn().mockRejectedValue(new Error('Network error'));

      // Should not throw - errors are caught and logged
      await expect(
        (tool as any).ensureMcpServers('session-err', client, 'token')
      ).resolves.not.toThrow();
    });

    it('should skip user MCP injection when repos not provided', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
        // No sessionMCPRepo or mcpServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);
      await (tool as any).ensureMcpServers('session-no-repos', client, 'token');

      // Only Agor MCP should be injected (if token provided), no user MCP calls
      const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
      expect(getMcpServersForSession).not.toHaveBeenCalled();
    });

    it('should URL-encode the MCP token in the Agor MCP server URL', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      const client = (tool as any).getClientForDirectory(undefined);
      const tokenWithSpecialChars = 'token with spaces & special=chars';

      await (tool as any).ensureMcpServers('session-encode', client, tokenWithSpecialChars);

      const agorCall = mockMcpAddCalls.find((c) => c.name === 'agor');
      expect(agorCall).toBeDefined();
      expect((agorCall!.config as any).url).toBe(
        `http://localhost:3030/mcp?sessionToken=${encodeURIComponent(tokenWithSpecialChars)}`
      );
    });
  });

  describe('executeTask Integration', () => {
    it('should use directory-scoped client based on session worktree path', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      // Set context with a worktree path
      tool.setSessionContext(
        'session-wt',
        'oc-session-1',
        'model',
        'provider',
        '/worktree/path',
        'token'
      );

      // Call executeTask (no streaming callbacks for simpler test)
      await tool.executeTask?.('session-wt', 'test prompt', 'task-1');

      // Should have created a client with directory = /worktree/path
      const dirClient = createdClients.find((c) => c.directory === '/worktree/path');
      expect(dirClient).toBeDefined();
    });

    it('should call ensureMcpServers before sending prompt', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      tool.setSessionContext(
        'session-mcp',
        'oc-session-2',
        undefined,
        undefined,
        undefined,
        'my-token'
      );

      await tool.executeTask?.('session-mcp', 'test prompt', 'task-2');

      // Should have injected Agor MCP
      const agorCall = mockMcpAddCalls.find((c) => c.name === 'agor');
      expect(agorCall).toBeDefined();
    });

    it('should throw if session context is not set', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      // Don't call setSessionContext
      const result = await tool.executeTask?.('unknown-session', 'test', 'task-3');

      // Should return failed status (errors are caught internally)
      expect(result?.status).toBe('failed');
    });
  });

  describe('createSession with workingDirectory', () => {
    it('should use directory-scoped client when workingDirectory is provided', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      await tool.createSession?.({
        title: 'Test Session',
        workingDirectory: '/path/to/worktree',
      });

      // Should have created a client with directory set
      const dirClient = createdClients.find((c) => c.directory === '/path/to/worktree');
      expect(dirClient).toBeDefined();
    });

    it('should use default client when workingDirectory is not provided', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService
      );

      await tool.createSession?.({
        title: 'Test Session',
      });

      // Should have created a client without directory
      expect(createdClients.length).toBe(1);
      expect(createdClients[0].directory).toBeUndefined();
    });

    it('should reuse cached directory client across createSession and executeTask', async () => {
      const tool = new OpenCodeTool(
        { enabled: true, serverUrl: 'http://localhost:4096' },
        mockMessagesService,
        mockSessionMCPRepo,
        mockMCPServerRepo
      );

      // Create session with directory
      const result = await tool.createSession?.({
        title: 'Test',
        workingDirectory: '/shared/path',
      });

      // Set context with same directory
      tool.setSessionContext(
        'session-shared',
        result!.sessionId,
        undefined,
        undefined,
        '/shared/path'
      );

      // Execute task - should reuse the same client
      await tool.executeTask?.('session-shared', 'test', 'task-shared');

      // Only 1 client should have been created for /shared/path
      const dirClients = createdClients.filter((c) => c.directory === '/shared/path');
      expect(dirClients.length).toBe(1);
    });
  });
});
