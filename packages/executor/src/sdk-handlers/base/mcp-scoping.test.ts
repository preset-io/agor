import type { MCPServer, MCPServerID, Session, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type {
  MCPServerRepository,
  SessionMCPServerRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';
import { getMcpServersForSession } from './mcp-scoping.js';

/**
 * Executor-side integration coverage for the `session.custom_context.*` template
 * channel (PR #1287). The `@agor/core` builder/resolver are unit-tested in
 * `template-resolver.test.ts`; this file covers the executor glue that those tests
 * can't reach: the `sessionRepo.findById` fetch, the non-fatal error fallback, and
 * the thread-through into `buildMCPTemplateContext`. That path is easy to quietly
 * break when someone refactors the deps object, which is exactly what these guard.
 */

const SESSION_ID = 'sess-1234' as SessionID;

/** A global HTTP MCP server whose bearer token is a session.custom_context template. */
function templatedGlobalServer(): MCPServer {
  return {
    mcp_server_id: 'mcp-1' as MCPServerID,
    name: 'external-mcp',
    transport: 'http',
    scope: 'global',
    enabled: true,
    source: 'user',
    url: 'https://api.example.com/mcp',
    auth: { type: 'bearer', token: '{{ session.custom_context.upstream_jwt }}' },
    created_at: new Date(),
    updated_at: new Date(),
  } as MCPServer;
}

/** Build the three repo deps; each method is overridable per test. */
function makeDeps(opts: {
  globalServers?: MCPServer[];
  sessionRow?: Partial<Session> | null;
  sessionRepo?: SessionRepository; // pass explicitly to test the "absent" case
  findByIdImpl?: () => Promise<Session | null>;
}) {
  const sessionMCPRepo = {
    listServers: vi.fn().mockResolvedValue([]),
  } as unknown as SessionMCPServerRepository;

  const mcpServerRepo = {
    findAll: vi.fn().mockResolvedValue(opts.globalServers ?? []),
  } as unknown as MCPServerRepository;

  const sessionRepo =
    'sessionRepo' in opts
      ? opts.sessionRepo
      : ({
          findById: opts.findByIdImpl ?? vi.fn().mockResolvedValue(opts.sessionRow ?? null),
        } as unknown as SessionRepository);

  return { sessionMCPRepo, mcpServerRepo, sessionRepo };
}

describe('getMcpServersForSession — session.custom_context resolution', () => {
  it('resolves {{session.custom_context.*}} into auth.token when sessionRepo is wired', async () => {
    const deps = makeDeps({
      globalServers: [templatedGlobalServer()],
      sessionRow: {
        session_id: SESSION_ID,
        custom_context: { upstream_jwt: 'resolved-jwt-value' },
      },
    });

    const result = await getMcpServersForSession(SESSION_ID, deps);

    expect(result).toHaveLength(1);
    expect(result[0].server.auth?.token).toBe('resolved-jwt-value');
    // The session row must have been fetched to resolve the template.
    expect(deps.sessionRepo?.findById).toHaveBeenCalledWith(SESSION_ID);
  });

  it('is non-fatal when sessionRepo.findById throws — server is still returned, template unresolved', async () => {
    const deps = makeDeps({
      globalServers: [templatedGlobalServer()],
      findByIdImpl: vi.fn().mockRejectedValue(new Error('db down')),
    });

    // Must NOT throw — a failed session fetch degrades gracefully.
    const result = await getMcpServersForSession(SESSION_ID, deps);

    // The server's url is static, so it stays valid and is returned; the optional
    // auth.token template couldn't resolve (no custom_context fetched) so it's
    // dropped rather than substituted with a real value — and crucially, no throw.
    expect(result).toHaveLength(1);
    expect(result[0].server.auth?.token).toBeFalsy();
    expect(result[0].server.auth?.token).not.toBe('resolved-jwt-value');
  });

  it('omits the session namespace entirely when sessionRepo is absent (legacy call sites)', async () => {
    const deps = makeDeps({
      globalServers: [templatedGlobalServer()],
      sessionRepo: undefined, // simulate a handler that never wired sessionRepo
    });

    const result = await getMcpServersForSession(SESSION_ID, deps);

    expect(result).toHaveLength(1);
    // With no session context, {{session.custom_context.*}} resolves empty and the
    // optional token field is dropped — it is NOT substituted with any value.
    expect(result[0].server.auth?.token).toBeFalsy();
  });

  it('still resolves (no throw) when the session row has no custom_context blob', async () => {
    const deps = makeDeps({
      globalServers: [templatedGlobalServer()],
      sessionRow: { session_id: SESSION_ID, custom_context: undefined },
    });

    const result = await getMcpServersForSession(SESSION_ID, deps);

    expect(result).toHaveLength(1);
    expect(result[0].server.auth?.token).toBeFalsy();
  });
});
