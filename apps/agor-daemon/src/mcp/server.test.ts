import type { Request, Response } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRegistry, coerceJsonRecord, setupMCPRoutes } from './server.js';

describe('coerceJsonRecord', () => {
  it('passes through a plain object unchanged', () => {
    const obj = { boardId: '123', name: 'test' };
    expect(coerceJsonRecord(obj)).toBe(obj);
  });

  it('passes through undefined unchanged', () => {
    expect(coerceJsonRecord(undefined)).toBeUndefined();
  });

  it('passes through null unchanged', () => {
    expect(coerceJsonRecord(null)).toBeNull();
  });

  it('passes through a number unchanged', () => {
    expect(coerceJsonRecord(42)).toBe(42);
  });

  it('parses a JSON-stringified object back to an object', () => {
    const input = JSON.stringify({ boardId: '123', name: 'test' });
    expect(coerceJsonRecord(input)).toEqual({ boardId: '123', name: 'test' });
  });

  it('parses a complex stringified object with markdown content', () => {
    const obj = {
      branchId: 'abc-123',
      initialPrompt:
        '# Hello\n\nSome **markdown** with `backticks` and\n\n```ts\nconst x = 1;\n```',
    };
    expect(coerceJsonRecord(JSON.stringify(obj))).toEqual(obj);
  });

  it('returns "null" string parsed as null (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('null')).toBeNull();
  });

  it('returns "[]" string parsed as array (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('[]')).toEqual([]);
  });

  it('returns "42" string parsed as number (Zod rejects downstream)', () => {
    expect(coerceJsonRecord('42')).toBe(42);
  });

  it('returns empty string unchanged (not valid JSON)', () => {
    expect(coerceJsonRecord('')).toBe('');
  });

  it('returns malformed JSON string unchanged', () => {
    expect(coerceJsonRecord('{bad json')).toBe('{bad json');
  });

  it('returns non-JSON string unchanged', () => {
    expect(coerceJsonRecord('hello world')).toBe('hello world');
  });
});

describe('MCP tool registry', () => {
  it('mirrors runtime read-only service tier filtering', () => {
    const registry = buildRegistry({ boards: 'readonly' });

    expect(registry.get('agor_boards_get')).toBeDefined();
    expect(registry.get('agor_boards_list')).toBeDefined();
    expect(registry.get('agor_boards_update')).toBeUndefined();
    expect(registry.get('agor_boards_create')).toBeUndefined();
  });

  it('keeps representative tool detail schemas from degrading to bare object schemas', () => {
    const registry = buildRegistry();
    const expectedPropertiesByTool: Record<string, string[]> = {
      agor_sessions_prompt: ['sessionId', 'prompt', 'mode'],
      agor_boards_get: ['boardId'],
      agor_branches_create: ['repoId', 'branchName', 'boardId'],
      agor_kb_get: ['uri', 'namespace', 'path'],
      agor_execute_tool: ['tool_name', 'arguments'],
    };

    for (const [toolName, expectedProperties] of Object.entries(expectedPropertiesByTool)) {
      const schema = registry.get(toolName)?.inputSchema;
      expect(schema, `${toolName} should be registered`).toBeDefined();
      expect(schema, `${toolName} should not degrade to { type: "object" }`).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      });

      for (const property of expectedProperties) {
        expect(
          (schema?.properties as Record<string, unknown> | undefined)?.[property],
          `${toolName} should expose ${property} in JSON schema`
        ).toBeDefined();
      }
    }
  });
});

/**
 * Capture the Express handler registered by setupMCPRoutes so the
 * token-source validation branches can be tested without spinning up
 * the full FeathersJS stack.
 */
function captureMcpHandler() {
  let handler: ((req: Request, res: Response) => Promise<unknown> | unknown) | null = null;
  const register = (_path: string, fn: typeof handler) => {
    handler = fn;
  };
  const app = {
    post: register,
    get: register,
    delete: register,
    service: (name: string) => {
      if (name !== 'users' && name !== 'sessions') {
        throw new Error(`Unexpected service lookup: ${name}`);
      }
      return {
        get: vi.fn(async () => {
          throw new Error(`Unexpected ${name}.get call`);
        }),
      };
    },
  } as unknown as Parameters<typeof setupMCPRoutes>[0];
  setupMCPRoutes(app, {} as never, /* toolSearchEnabled */ false);
  if (!handler) throw new Error('MCP handler was not registered');
  return handler;
}

function buildRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    on(_event: string, _cb: () => void) {
      return this;
    },
  };
  return res;
}

describe('POST /mcp token source', () => {
  afterEach(() => {
    // Restore any spies installed per-test (e.g. console.warn) so later
    // suites start from a clean slate.
    vi.restoreAllMocks();
  });

  it('rejects requests with ?sessionToken= query param (400)', async () => {
    const handler = captureMcpHandler();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: { sessionToken: 'leaky-token-value' },
      headers: {},
      body: { id: 7 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    const body = res.body as { error?: { message?: string }; id?: number };
    expect(body?.error?.message).toMatch(/no longer accepted/i);
    expect(body?.id).toBe(7);
    // The deprecation log must never include the token value.
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('leaky-token-value');
    warn.mockRestore();
  });

  it('rejects requests with no Authorization header (401)', async () => {
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: {},
      headers: {},
      body: { id: 8 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    const body = res.body as { error?: { message?: string } };
    expect(body?.error?.message).toMatch(/authorization: bearer/i);
  });

  it('rejects an invalid personal API key from X-API-Key (401)', async () => {
    const { UserApiKeysRepository } = await import('@agor/core/db');
    vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockResolvedValue(null);
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: {},
      headers: { 'x-api-key': 'agor_sk_invalid' },
      body: { id: 10 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    const body = res.body as { error?: { message?: string }; id?: number };
    expect(body.id).toBe(10);
    expect(body.error?.message).toMatch(/invalid personal api key/i);
  });

  it('rejects even when query has both ?sessionToken= and an Authorization header (query wins → 400)', async () => {
    const handler = captureMcpHandler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'POST',
      query: { sessionToken: 'qp' },
      headers: { authorization: 'Bearer header-token' },
      body: { id: 9 },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = buildRes();
    await handler(req, res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('logs the deprecation warning at most once per caller IP', async () => {
    const handler = captureMcpHandler();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Use a unique IP so the module-level Set isn't already populated for it.
    const uniqueIp = `10.9.8.${Math.floor(Math.random() * 255)}`;
    const makeReq = () =>
      ({
        method: 'POST',
        query: { sessionToken: 'x' },
        headers: {},
        body: { id: 1 },
        ip: uniqueIp,
        socket: { remoteAddress: uniqueIp },
      }) as unknown as Request;

    await handler(makeReq(), buildRes() as unknown as Response);
    const firstCount = warn.mock.calls.length;
    await handler(makeReq(), buildRes() as unknown as Response);
    await handler(makeReq(), buildRes() as unknown as Response);
    // Second and third calls from the same IP must not emit another warn.
    expect(warn.mock.calls.length).toBe(firstCount);

    // A different IP still warns.
    const otherIp = `10.9.7.${Math.floor(Math.random() * 255)}`;
    const otherReq = {
      method: 'POST',
      query: { sessionToken: 'x' },
      headers: {},
      body: { id: 2 },
      ip: otherIp,
      socket: { remoteAddress: otherIp },
    } as unknown as Request;
    await handler(otherReq, buildRes() as unknown as Response);
    expect(warn.mock.calls.length).toBe(firstCount + 1);
    warn.mockRestore();
  });
});

describe('POST /mcp with personal API keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockPersonalApiKeyUser(userId = 'user-1') {
    const keyRows = {
      agor_sk_valid: {
        id: 'key-1',
        user_id: userId,
        name: 'orchestrator',
        prefix: 'agor_sk_123',
        key_hash: 'hash',
        created_at: new Date(),
        last_used_at: null,
      },
      agor_sk_other: {
        id: 'key-2',
        user_id: 'user-2',
        name: 'other',
        prefix: 'agor_sk_456',
        key_hash: 'hash',
        created_at: new Date(),
        last_used_at: null,
      },
    };
    return import('@agor/core/db').then(({ UserApiKeysRepository }) => {
      vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockImplementation(async (key) => {
        return keyRows[key as keyof typeof keyRows] ?? null;
      });
      vi.spyOn(UserApiKeysRepository.prototype, 'updateLastUsed').mockResolvedValue();
    });
  }

  async function withMcpServer(
    services: Record<string, unknown>,
    fn: (baseUrl: string) => Promise<void>
  ) {
    const webApp = express();
    webApp.use(express.json());
    (webApp as unknown as { service: (name: string) => unknown }).service = (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service lookup: ${name}`);
      return svc;
    };

    setupMCPRoutes(webApp as never, {} as never, /* toolSearchEnabled */ false);

    const httpServer = webApp.listen(0);
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('no listen address');
      await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  function parseMcpResponse(text: string) {
    const dataLine = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(dataLine ?? text) as {
      result?: { content?: Array<{ text: string }> };
      error?: { message: string };
    };
  }

  async function initializeStatefulMcp(baseUrl: string, apiKey = 'agor_sk_valid') {
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      }),
    });
    expect(resp.status).toBe(200);
    const mcpSessionId = resp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await resp.text();
    return mcpSessionId!;
  }

  async function markStatefulMcpInitialized(baseUrl: string, mcpSessionId: string) {
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': 'agor_sk_valid',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(resp.status).toBeGreaterThanOrEqual(200);
    expect(resp.status).toBeLessThan(300);
    await resp.text();
  }

  async function callCurrentUserStatefully(baseUrl: string, mcpSessionId: string) {
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': 'agor_sk_valid',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: { name: 'agor_users_get_current', arguments: {} },
      }),
    });
    const parsed = parseMcpResponse(await resp.text());
    return { resp, parsed };
  }

  it('can call a non-session-scoped tool without X-Agor-Session-Id / ?sessionId', async () => {
    const { UserApiKeysRepository } = await import('@agor/core/db');
    vi.spyOn(UserApiKeysRepository.prototype, 'verifyKey').mockResolvedValue({
      id: 'key-1',
      user_id: 'user-1',
      name: 'orchestrator',
      prefix: 'agor_sk_123',
      key_hash: 'hash',
      created_at: new Date(),
      last_used_at: null,
    });
    vi.spyOn(UserApiKeysRepository.prototype, 'updateLastUsed').mockResolvedValue();

    const webApp = express();
    webApp.use(express.json());
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    (webApp as unknown as { service: (name: string) => unknown }).service = (name: string) => {
      if (name !== 'users') throw new Error(`Unexpected service lookup: ${name}`);
      return { get: getUser };
    };

    setupMCPRoutes(webApp as never, {} as never, /* toolSearchEnabled */ false);

    const httpServer = webApp.listen(0);
    try {
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('no listen address');
      const resp = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'agor_sk_valid',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'agor_users_get_current', arguments: {} },
        }),
      });

      expect(resp.status).toBe(200);
      const responseText = await resp.text();
      const dataLine = responseText
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (!dataLine) throw new Error(`No SSE data line in response: ${responseText}`);
      const body = JSON.parse(dataLine) as {
        result?: { content: Array<{ text: string }> };
        error?: { message: string };
      };
      expect(body.error).toBeUndefined();
      const result = JSON.parse(body.result!.content[0].text);
      expect(result.user_id).toBe('user-1');
      expect(getUser).toHaveBeenCalledWith('user-1');
      expect(UserApiKeysRepository.prototype.updateLastUsed).toHaveBeenCalledWith('key-1');
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('accepts a valid personal API key session context from X-Agor-Session-Id', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'agor_sk_valid',
            'X-Agor-Session-Id': 'session-short',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'agor_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(200);
        expect(parseMcpResponse(await resp.text()).error).toBeUndefined();
        expect(getSession).toHaveBeenCalledWith(
          'session-short',
          expect.objectContaining({
            authenticated: true,
            provider: 'mcp',
            user: expect.objectContaining({ user_id: 'user-1', role: 'member' }),
          })
        );
      }
    );
  });

  it('accepts a valid personal API key session context from ?sessionId=', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp?sessionId=session-query`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'agor_sk_valid',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'agor_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(200);
        expect(parseMcpResponse(await resp.text()).error).toBeUndefined();
        expect(getSession).toHaveBeenCalledWith('session-query', expect.any(Object));
      }
    );
  });

  it('rejects inaccessible personal API key session context', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => {
      throw new Error('no access');
    });

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'agor_sk_valid',
            'X-Agor-Session-Id': 'forbidden-session',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'agor_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(403);
        const body = (await resp.json()) as { error?: { message?: string } };
        expect(body.error?.message).toMatch(/not accessible/i);
      }
    );
  });

  it('rejects adding X-Agor-Session-Id to a sessionless stateful MCP session', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    const getSession = vi.fn(async () => ({ session_id: 'session-full-id' }));

    await withMcpServer(
      { users: { get: getUser }, sessions: { get: getSession } },
      async (baseUrl) => {
        const mcpSessionId = await initializeStatefulMcp(baseUrl);
        const resp = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'X-API-Key': 'agor_sk_valid',
            'Mcp-Session-Id': mcpSessionId,
            'X-Agor-Session-Id': 'session-full-id',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: { name: 'agor_users_get_current', arguments: {} },
          }),
        });

        expect(resp.status).toBe(403);
        const body = (await resp.json()) as { error?: { message?: string } };
        expect(body.error?.message).toMatch(/initialized without/i);
      }
    );
  });

  it('rejects a stateful MCP request from a different API key user', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async (id: string) => ({
      user_id: id,
      email: `${id}@example.com`,
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const mcpSessionId = await initializeStatefulMcp(baseUrl, 'agor_sk_valid');
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'agor_sk_other',
          'Mcp-Session-Id': mcpSessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'agor_users_get_current', arguments: {} },
        }),
      });

      expect(resp.status).toBe(403);
      const body = (await resp.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/different user/i);
    });
  });

  it('DELETE closes a stateful MCP session and subsequent use returns 404', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const mcpSessionId = await initializeStatefulMcp(baseUrl);
      const deleteResp = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json, text/event-stream',
          'X-API-Key': 'agor_sk_valid',
          'Mcp-Session-Id': mcpSessionId,
        },
      });
      expect(deleteResp.status).toBe(200);
      await deleteResp.text();

      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': 'agor_sk_valid',
          'Mcp-Session-Id': mcpSessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'agor_users_get_current', arguments: {} },
        }),
      });

      expect(resp.status).toBe(404);
    });
  });

  it('refreshes user role context on each stateful MCP request', async () => {
    await mockPersonalApiKeyUser();
    let role = 'superadmin';
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role,
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const mcpSessionId = await initializeStatefulMcp(baseUrl);
      await markStatefulMcpInitialized(baseUrl, mcpSessionId);

      role = 'member';
      const { resp, parsed } = await callCurrentUserStatefully(baseUrl, mcpSessionId);

      expect(resp.status).toBe(200);
      expect(parsed.error).toBeUndefined();
      const result = JSON.parse(parsed.result!.content![0].text);
      expect(result.role).toBe('member');
      // initialize auth, initialized notification auth, tool-call auth, then
      // the tool itself. The returned role proves the stateful tool context
      // observed the freshly reloaded user rather than the initialize-time one.
      expect(getUser).toHaveBeenCalledTimes(4);
    });
  });

  it('keeps a stateful MCP session usable after a GET SSE disconnect', async () => {
    await mockPersonalApiKeyUser();
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));

    await withMcpServer({ users: { get: getUser } }, async (baseUrl) => {
      const mcpSessionId = await initializeStatefulMcp(baseUrl);
      await markStatefulMcpInitialized(baseUrl, mcpSessionId);

      const sseResp = await fetch(`${baseUrl}/mcp`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'X-API-Key': 'agor_sk_valid',
          'Mcp-Session-Id': mcpSessionId,
        },
      });
      expect(sseResp.status).toBe(200);
      await sseResp.body?.cancel();

      const { resp, parsed } = await callCurrentUserStatefully(baseUrl, mcpSessionId);

      expect(resp.status).toBe(200);
      expect(parsed.error).toBeUndefined();
      const result = JSON.parse(parsed.result!.content![0].text);
      expect(result.user_id).toBe('user-1');
    });
  });
});
