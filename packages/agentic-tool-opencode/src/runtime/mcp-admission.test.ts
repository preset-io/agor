/**
 * OpenCode's invocation config carries no per-tool filter, so withholding the
 * whole server is the only way a `deny` or `ask` can bind here. That makes the
 * declarative config the enforcement boundary: a gated server must be absent
 * from what gets handed to the managed server, not merely absent from some
 * intermediate list.
 */

import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { getMcpServersForSession } from '@agor/core/mcp';
import type { MCPServer, MessageID, SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedChild } from './managed-server';
import { OpenCodeTool } from './opencode-tool';

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
        { toolFiltering: 'none' }
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
  it('omits a server whose tools are gated, while keeping the rest', async () => {
    const { config, withheld } = await buildConfig([
      server(GATED, { write_file: 'deny' }),
      server(PLAIN),
    ]);
    const configured = Object.keys(config.mcp).join(' ');

    expect(configured).not.toContain(sanitized(GATED));
    // Positive control: the builder does emit servers, so the absence above is
    // the gate and not an empty config.
    expect(configured).toContain(sanitized(PLAIN));
    // A server that vanishes without a word is indistinguishable from a broken
    // one, so the gate has to say so as well as act.
    expect(withheld).toEqual([GATED]);
  });

  it('omits a server gated with ask, which has no prompt channel here', async () => {
    const { config, withheld } = await buildConfig([
      server(GATED, { write_file: 'ask' }),
      server(PLAIN),
    ]);

    expect(Object.keys(config.mcp).join(' ')).not.toContain(sanitized(GATED));
    expect(withheld).toEqual([GATED]);
  });

  it('keeps the built-in Agor server addressable', async () => {
    const { config, withheld } = await buildConfig([server(PLAIN)]);

    expect(Object.keys(config.mcp).some((name) => name.startsWith('agor_'))).toBe(true);
    expect(withheld).toEqual([]);
  });
});

/**
 * The config object is an intermediate. What the OpenCode process actually
 * obeys is `OPENCODE_CONFIG_CONTENT` on its own environment, so that string is
 * where a `deny` either binds or does not.
 */
describe('MCP servers reaching the OpenCode process environment', () => {
  it('never names a gated server in OPENCODE_CONFIG_CONTENT', async () => {
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
          { toolFiltering: 'none' }
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
    expect(configContent).not.toContain(sanitized(GATED));
    expect(configContent).not.toContain(GATED);
    // Positive control: an ungated server does make it into the same string,
    // so the two absences above are the gate and not a stubbed-out config.
    expect(configContent).toContain(sanitized(PLAIN));
  });
});
