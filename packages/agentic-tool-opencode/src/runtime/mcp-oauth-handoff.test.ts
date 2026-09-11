import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { AgorClient } from '@agor/core/api';
import { getMcpServersForSession } from '@agor/core/mcp';
import type {
  MCPServer,
  MCPServerID,
  MessageID,
  SessionID,
  TaskID,
  UserID,
} from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeathersMCPOAuthAuthHeadersRepository } from '../../../executor/src/db/feathers-repositories';
import type { ManagedChild } from './managed-server';
import { OpenCodeTool } from './opencode-tool';

const sessionId = 'fictional-session' as SessionID;
const server = (transport: 'http' | 'sse' = 'http'): MCPServer => ({
  mcp_server_id: 'fictional-server' as MCPServerID,
  name: 'fictional',
  transport,
  url: 'https://mcp.example.test/mcp',
  scope: 'session',
  source: 'user',
  enabled: true,
  owner_user_id: 'caller-a' as UserID,
  created_at: new Date(0),
  updated_at: new Date(0),
  auth: { type: 'oauth', oauth_mode: 'per_user', oauth_token_expires_at: 1 },
  headers: { 'X-Fictional': 'custom', aUtHoRiZaTiOn: 'must-not-win' },
});

function fixture(
  servers: MCPServer[],
  response: { authorization?: string; error?: string },
  caller = 'caller-a'
) {
  const create = vi.fn(async () => ({ headers: { 'fictional-server': response } }));
  const repo = new FeathersMCPOAuthAuthHeadersRepository({
    service: (path: string) => {
      expect(path).toBe('mcp-servers/oauth-auth-headers');
      return { create };
    },
  } as unknown as AgorClient);
  const listEffectiveServers = vi.fn(async () => servers);
  const resolveMcpServers = (id: SessionID) =>
    getMcpServersForSession(
      id,
      {
        sessionMCPRepo: { listServers: async () => servers, listEffectiveServers },
        mcpServerRepo: { findAll: async () => [] },
        mcpOAuthAuthHeadersRepo: repo,
        forUserId: caller,
      },
      { toolFiltering: 'intercept' }
    );
  const dependencies = {
    resolveMcpServers,
    getDaemonUrl: async () => 'https://daemon.example.test',
  };
  const build = () =>
    (
      new OpenCodeTool(dependencies) as unknown as {
        buildInvocationConfig(
          id: SessionID,
          token: string
        ): Promise<{ mcp: Record<string, { headers?: Record<string, string> }> }>;
      }
    ).buildInvocationConfig(sessionId, 'fictional-agor-token');
  return { build, dependencies, create, listEffectiveServers };
}

afterEach(() => vi.restoreAllMocks());

describe('executor repository to OpenCode OAuth handoff', () => {
  it.each(['http', 'sse'] as const)(
    'uses the authority bearer for %s, not stale configured expiry or custom Authorization',
    async (transport) => {
      const f = fixture([server(transport)], { authorization: 'Bearer fictional-current-access' });
      const { mcp } = await f.build();
      expect(Object.values(mcp).find((entry) => entry.headers?.['X-Fictional'])).toMatchObject({
        headers: { Authorization: 'Bearer fictional-current-access', 'X-Fictional': 'custom' },
      });
      expect(JSON.stringify(mcp)).not.toContain('must-not-win');
      expect(f.create).toHaveBeenCalledWith({ mcp_server_ids: ['fictional-server'] });
      expect(f.listEffectiveServers).toHaveBeenCalledWith(sessionId, true, 'caller-a');
    }
  );

  it.each([
    {},
    { error: 'needs_reauth' },
    { error: 'token_refresh_failed' },
    { authorization: 'Bearer ' },
    { authorization: 'Basic fictional' },
  ])(
    'fails closed on missing, expired/unrefreshable or unusable authority result %j',
    async (response) => {
      const configured = server();
      configured.auth = {
        ...configured.auth!,
        oauth_client_id: 'fictional-client',
        oauth_client_secret: 'fictional-secret',
        oauth_token_url: 'https://auth.example.test/token',
      };
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
      await expect(fixture([configured], response).build()).rejects.toThrow(
        'usable Authorization header'
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('does not hide an unavailable credential authority or leak its error', async () => {
    const f = fixture([server()], {});
    f.create.mockRejectedValue(new Error('fictional-private-error'));
    await expect(f.build()).rejects.toThrow('Attached MCP server fictional authentication failed');
  });

  it('does not borrow a different caller’s private attachment or request its bearer', async () => {
    const f = fixture([server()], { authorization: 'Bearer fictional-owner-access' }, 'caller-b');
    expect(Object.keys((await f.build()).mcp)).toHaveLength(1);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('keeps a detached baseline, stdio and no-auth remote independent of OAuth', async () => {
    const plain = { ...server(), auth: { type: 'none' as const }, headers: undefined };
    const local = {
      ...server(),
      mcp_server_id: 'local',
      name: 'local',
      transport: 'stdio',
      command: '/fictional/tool',
      url: undefined,
      auth: undefined,
      headers: undefined,
    } as MCPServer;
    const f = fixture([plain, local], {});
    expect(Object.keys((await f.build()).mcp)).toHaveLength(3);
    expect(f.create).not.toHaveBeenCalled();
    expect(Object.keys((await fixture([], {}).build()).mcp)).toHaveLength(1);
  });

  it('delivers only the authorized access header to the managed process config before any model call', async () => {
    const f = fixture([server()], { authorization: 'Bearer fictional-refreshed-access' });
    const envs: Array<NodeJS.ProcessEnv> = [];
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => true,
    }) as ManagedChild;
    const tool = new OpenCodeTool({
      ...f.dependencies,
      resolveBinary: async () => ({
        executable: process.execPath,
        argsPrefix: ['/fictional-opencode'],
      }),
      spawn: (_executable, _args, options) => {
        envs.push(options.env ?? {});
        setImmediate(() => stdout.write('opencode server listening on http://127.0.0.1:43210\n'));
        return child;
      },
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      createClient: () => {
        throw new Error('Stop at config handoff; no model call');
      },
    });
    await expect(
      tool.runTurn({
        agorSessionId: sessionId,
        taskId: 'fictional-task' as TaskID,
        agorAssistantMessageId: 'fictional-message' as MessageID,
        prompt: 'fictional',
        title: 'fictional',
        directory: tmpdir(),
        provider: 'ollama',
        model: 'fictional-model',
        mcpToken: 'fictional-agor-token',
        signal: new AbortController().signal,
        persistOpenCodeSessionId: async () => {},
      })
    ).rejects.toThrow();
    expect(envs).toHaveLength(1);
    const content = envs[0].OPENCODE_CONFIG_CONTENT ?? '';
    expect(content).toContain('Bearer fictional-refreshed-access');
    expect(content).not.toMatch(
      /oauth_refresh_token|oauth_client_secret|oauthAuthResolution|must-not-win/
    );
  });
});
