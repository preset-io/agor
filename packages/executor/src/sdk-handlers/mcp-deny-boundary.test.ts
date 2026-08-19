/**
 * Transport-level proof that a denied MCP tool never reaches its server.
 *
 * The original defect was integration-shaped: `tool_permissions` was persisted
 * and every execution path ignored it. A test that only re-checks a decision
 * function cannot catch that class, so these cases run a REAL MCP server over
 * the real protocol and assert on the server's own `tools/call` counter.
 *
 * Each case carries a positive control — an allowed call that must arrive. A
 * zero counter only means something if the same harness can deliver.
 *
 * Boundary of the proof: the last hop into Claude's own rule matcher runs
 * inside the Claude CLI, which needs credentials and a live model turn, so the
 * config it would consume is applied here instead. Everything upstream of that
 * — scoping, admission, index construction, hook and callback decisions — is
 * the production code path.
 */

import {
  getMcpServersForSession,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
} from '@agor/core/mcp';
import type { MCPServer, SessionID, TaskID } from '@agor/core/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpToolPermissionHook } from './base/mcp-tool-permission-hook.js';
import {
  buildMcpToolPermissionIndex,
  mcpToolNameAliasesForServer,
} from './base/mcp-tool-permissions.js';
import { createCanUseToolCallback } from './base/permission-hooks.js';

const SERVER_NAME = 'files';
const DENIED_TOOL = 'write_file';
const ALLOWED_TOOL = 'read_file';

/** A real MCP server that records every tool invocation that reaches it. */
async function startCountingMcpServer() {
  const calls: string[] = [];
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });

  for (const toolName of [DENIED_TOOL, ALLOWED_TOOL]) {
    server.tool(toolName, async () => {
      calls.push(toolName);
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'harness', version: '1.0.0' });
  await client.connect(clientTransport);

  return { calls, client, close: () => client.close() };
}

function serverRow(): MCPServer {
  return {
    mcp_server_id: 'files-server',
    name: SERVER_NAME,
    transport: 'stdio',
    command: 'noop',
    scope: 'global',
    source: 'user',
    enabled: true,
    tools: [{ name: DENIED_TOOL, description: '' }],
    tool_permissions: { [DENIED_TOOL]: 'deny' },
  } as unknown as MCPServer;
}

function resolutionDeps(server: MCPServer) {
  return {
    mcpServerRepo: { findAll: vi.fn() } as never,
    sessionMCPRepo: { listEffectiveServers: vi.fn().mockResolvedValue([server]) } as never,
  };
}

describe('a denied MCP tool never reaches the server', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is not reachable on a handler that cannot filter tools, because the server is withheld', async () => {
    const mcp = await startCountingMcpServer();
    try {
      // Production scoping + admission decides what the handler may attach.
      const attached = await getMcpServersForSession(
        'session-a' as SessionID,
        resolutionDeps(serverRow()),
        {
          toolFiltering: 'none',
        }
      );

      // A handler can only dispatch to a server it was handed.
      const reachable = new Set(attached.map(({ server }) => server.name));
      expect(reachable.has(SERVER_NAME)).toBe(false);

      if (reachable.has(SERVER_NAME)) {
        await mcp.client.callTool({ name: DENIED_TOOL, arguments: {} });
      }

      expect(mcp.calls).toEqual([]);

      // Positive control: the same fixture under a handler that CAN filter is
      // admitted, so the withholding above is the gate and not a resolver that
      // returns nothing.
      const admitted = await getMcpServersForSession(
        'session-a' as SessionID,
        resolutionDeps(serverRow()),
        { toolFiltering: 'exclude' }
      );
      expect(admitted.map(({ server }) => server.name)).toEqual([SERVER_NAME]);
    } finally {
      await mcp.close();
    }
  });

  it('is blocked at the Claude gates while an allowed tool still gets through', async () => {
    const mcp = await startCountingMcpServer();
    try {
      const attached = await getMcpServersForSession(
        'session-a' as SessionID,
        resolutionDeps(serverRow()),
        {
          toolFiltering: 'exclude',
        }
      );
      // An `exclude` handler keeps the server — enforcement is per tool.
      expect(attached.map(({ server }) => server.name)).toEqual([SERVER_NAME]);

      const servers = attached.map(({ server }) => server);
      const index = buildMcpToolPermissionIndex(servers);

      // The exact config `setupQuery` hands the SDK.
      const disallowedTools = new Set(
        servers.flatMap((server) =>
          listMcpToolsWithPermission(server, PERMISSIONS_BLOCKED_WITHOUT_PROMPT).flatMap((tool) =>
            [...new Set(mcpToolNameAliasesForServer(server.name))].map(
              (alias) => `mcp__${alias}__${tool}`
            )
          )
        )
      );
      const preToolUse = createMcpToolPermissionHook(index, true);
      const canUseTool = createCanUseToolCallback('session-a' as SessionID, 't1' as TaskID, {
        permissionService: {
          emitRequest: vi.fn(),
          waitForDecision: vi.fn(),
          cancelPendingRequests: vi.fn(),
        } as never,
        tasksService: { patch: vi.fn().mockResolvedValue(undefined) } as never,
        messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) } as never,
        sessionsService: { patch: vi.fn().mockResolvedValue(undefined) } as never,
        permissionLocks: new Map(),
        mcpServerRepo: {} as never,
        sessionMCPRepo: {
          listServers: vi.fn().mockResolvedValue([{ name: SERVER_NAME }]),
        } as never,
        mcpToolPermissions: index,
      });

      // Applies the gates in the SDK's documented order, then dispatches over
      // the real transport. Anything the gates permit genuinely runs.
      async function attempt(bareTool: string) {
        const sdkToolName = `mcp__${SERVER_NAME}__${bareTool}`;
        if (disallowedTools.has(sdkToolName)) return 'blocked-by-rule';

        const hook = await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            tool_name: sdkToolName,
            tool_input: {},
            tool_use_id: 'u1',
          } as never,
          'u1',
          { signal: new AbortController().signal }
        );
        if (hook.hookSpecificOutput?.permissionDecision === 'deny') return 'blocked-by-hook';

        const decision = await canUseTool(
          sdkToolName,
          {},
          {
            signal: new AbortController().signal,
          }
        );
        if (decision.behavior !== 'allow') return 'blocked-by-callback';

        await mcp.client.callTool({ name: bareTool, arguments: {} });
        return 'dispatched';
      }

      expect(await attempt(DENIED_TOOL)).toBe('blocked-by-rule');
      expect(mcp.calls).toEqual([]);

      // Positive control: the harness can reach the server, so the empty
      // counter above is enforcement and not a broken test.
      expect(await attempt(ALLOWED_TOOL)).toBe('dispatched');
      expect(mcp.calls).toEqual([ALLOWED_TOOL]);
    } finally {
      await mcp.close();
    }
  });
});
