/**
 * OpenCode's invocation config still carries no per-tool filter, but the
 * server no longer has to be withheld to make a `deny` bind: every MCP tool
 * call is asked back through Agor before it runs, using the tool's own key as
 * the permission type. Agor mints that key when it registers the server, so
 * the lookup is exact rather than a guess at where a namespaced name splits.
 *
 * These cases therefore pin the two halves that have to agree: the key the
 * config registers a server under, and the key the permission map is built
 * from. If those ever drift, every lookup misses, and a miss reads as
 * "unconfigured" — which is `allow`.
 *
 * What is NOT proven here is that OpenCode reports exactly that string. That
 * comes from the shipped 1.14.33 binary, where the MCP tool registry composes
 * `CP(server) + "_" + CP(tool)` and the execute path calls
 * `ask({permission: <that key>})`, with `CP = s => s.replace(/[^a-zA-Z0-9_-]/g, "_")`.
 */

import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { getMcpServersForSession } from '@agor/core/mcp';
import type { MCPServer, MessageID, SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedChild } from './managed-server';
import { blockedByOpenCodeToolPermissions, OpenCodeTool } from './opencode-tool';

const GATED = 'gated-server';
const PLAIN = 'plain-server';
/** The builder sanitizes names into its key, so assertions match that form. */
const sanitized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

function server(id: string, toolPermissions?: MCPServer['tool_permissions']): MCPServer {
  return {
    mcp_server_id: id,
    name: id,
    transport: 'stdio',
    command: '/usr/bin/node',
    args: [],
    scope: 'global',
    source: 'user',
    enabled: true,
    tool_permissions: toolPermissions,
  } as unknown as MCPServer;
}

/**
 * Runs the production admission gate, not a restatement of it. A local copy of
 * the policy would keep passing after the real one drifted.
 */
async function buildConfig(servers: MCPServer[]) {
  const withheld: string[] = [];
  const tool = new OpenCodeTool({
    resolveMcpServers: (sessionId) =>
      getMcpServersForSession(
        sessionId,
        {
          sessionMCPRepo: { listEffectiveServers: vi.fn().mockResolvedValue(servers) } as never,
          mcpServerRepo: { findAll: vi.fn().mockResolvedValue([]) } as never,
          onServerWithheld: (server) => withheld.push(server.name),
        },
        { toolFiltering: 'intercept' }
      ),
    getDaemonUrl: async () => 'http://localhost:3030',
  });
  const config = await (
    tool as unknown as {
      buildInvocationConfig: (
        s: SessionID,
        t: string,
        d?: string
      ) => Promise<{ mcp: Record<string, unknown> }>;
    }
  ).buildInvocationConfig('session-1' as SessionID, 'token', '/branch');
  return { config, withheld };
}

describe('MCP servers reaching OpenCode invocation config', () => {
  it('now keeps a server whose tools are gated, because the gate moved to call time', async () => {
    const { config, withheld } = await buildConfig([
      server(GATED, { write_file: 'deny' }),
      server(PLAIN),
    ]);
    const configured = Object.keys(config.mcp).join(' ');

    // Previously this server was dropped whole. Users now get the server AND
    // the restriction rather than neither.
    expect(configured).toContain(sanitized(GATED));
    expect(configured).toContain(sanitized(PLAIN));
    expect(withheld).toEqual([]);
  });

  it('keys the permission map by exactly the name it registered the server under', async () => {
    const gated = server(GATED, { write_file: 'deny', read_file: 'allow' });
    const { config } = await buildConfig([gated, server(PLAIN)]);

    const registered = Object.keys(config.mcp).find((name) => name.includes(sanitized(GATED)));
    expect(registered).toBeDefined();

    // The load-bearing agreement: the map's key is the registered server key
    // plus the tool name. A mismatch here is a silent fail-open.
    expect(config.mcpToolPermissions?.get(`${registered}_write_file`)).toBe('deny');
    // Every configured entry is carried, not just the gated ones, so the map
    // stays a faithful copy of what the user set.
    expect(config.mcpToolPermissions?.get(`${registered}_read_file`)).toBe('allow');
  });

  it('keeps the built-in Agor server addressable', async () => {
    const { config, withheld } = await buildConfig([server(PLAIN)]);

    expect(Object.keys(config.mcp).some((name) => name.startsWith('agor_'))).toBe(true);
    expect(withheld).toEqual([]);
  });
});

/**
 * The decision itself. Extracted from `applyPermissionEffect` so it is
 * reachable without standing up a turn — the surrounding function is where
 * this is easy to get wrong, because the permission-mode shortcut next to it
 * answers `once` without ever consulting Agor.
 */
describe('the tool_permissions gate', () => {
  const gate = (
    configured: 'deny' | 'ask' | 'allow' | undefined,
    modeWouldAutoAllow = false,
    hasApprovalChannel = true
  ) => blockedByOpenCodeToolPermissions({ configured, modeWouldAutoAllow, hasApprovalChannel });

  it('refuses a denied tool even when the permission mode would auto-allow', () => {
    // bypassPermissions / allow-all / yolo never reach canUseTool, so this is
    // the only thing standing between the model and the tool in those modes.
    expect(gate('deny', true)).toBe('deny');
    expect(gate('deny', false)).toBe('deny');
  });

  it('lets an ask reach the prompt when someone can actually answer', () => {
    expect(gate('ask', false, true)).toBeUndefined();
  });

  it('fails an unanswerable ask closed rather than letting it become allow', () => {
    expect(gate('ask', true, true)).toBe('ask');
    expect(gate('ask', false, false)).toBe('ask');
  });

  it('leaves allowed and unconfigured tools alone', () => {
    // Unconfigured must mean "unchanged behaviour", never an implicit deny.
    expect(gate('allow', true)).toBeUndefined();
    expect(gate(undefined, true)).toBeUndefined();
    expect(gate(undefined, false, false)).toBeUndefined();
  });
});

/**
 * The config object is an intermediate. What the OpenCode process actually
 * obeys is `OPENCODE_CONFIG_CONTENT` on its own environment, so that string is
 * where a `deny` either binds or does not.
 */
describe('MCP servers reaching the OpenCode process environment', () => {
  it('hands both servers to the process without leaking Agor-side state', async () => {
    const spawnEnvs: Array<Record<string, string | undefined>> = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => true,
    }) as ManagedChild;

    const tool = new OpenCodeTool({
      resolveMcpServers: (sessionId) =>
        getMcpServersForSession(
          sessionId,
          {
            sessionMCPRepo: {
              listEffectiveServers: vi
                .fn()
                .mockResolvedValue([server(GATED, { write_file: 'deny' }), server(PLAIN)]),
            } as never,
            mcpServerRepo: { findAll: vi.fn().mockResolvedValue([]) } as never,
          },
          { toolFiltering: 'intercept' }
        ),
      getDaemonUrl: async () => 'http://localhost:3030',
      resolveBinary: async () => ({ executable: process.execPath, argsPrefix: ['/opencode'] }),
      spawn: (_executable, _args, options) => {
        spawnEnvs.push((options.env ?? {}) as Record<string, string | undefined>);
        setImmediate(() =>
          child.stdout.write('opencode server listening on http://127.0.0.1:43210\n')
        );
        return child;
      },
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      // The turn is abandoned here: spawn has already been handed the config,
      // which is the only thing under test.
      createClient: () => {
        throw new Error('stop after handoff');
      },
    });

    await expect(
      tool.runTurn({
        agorSessionId: 'session-1' as SessionID,
        taskId: 'task-1' as TaskID,
        prompt: 'hi',
        agorAssistantMessageId: 'message-1' as MessageID,
        title: 'turn',
        directory: tmpdir(),
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        mcpToken: 'token',
        signal: new AbortController().signal,
        persistOpenCodeSessionId: async () => {},
      })
    ).rejects.toThrow();

    expect(spawnEnvs).toHaveLength(1);
    const configContent = spawnEnvs[0].OPENCODE_CONFIG_CONTENT ?? '';
    // Both servers now reach the process; the gated one is restrained at call
    // time rather than by being kept out of the config.
    expect(configContent).toContain(sanitized(GATED));
    expect(configContent).toContain(sanitized(PLAIN));
    // The permission map is Agor-side state and must never be serialised into
    // the config the OpenCode process reads.
    expect(configContent).not.toContain('mcpToolPermissions');
  });
});
