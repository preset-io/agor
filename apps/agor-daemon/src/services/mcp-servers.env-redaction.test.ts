/**
 * What a member actually receives when they read an MCP server they did not
 * configure — issue #2292.
 *
 * `env` is where a stdio MCP server keeps its credentials, and a shared
 * (ownerless) server is usable, hence readable, by every member. Before the
 * fix this file exercises, `redactMCPServerSecrets` covered `headers` and
 * `auth` and stopped, so `GITHUB_TOKEN` came back in the clear to anyone who
 * could list servers.
 *
 * The point of driving the real service and the real redaction gate rather
 * than unit-testing the helper is that the helper was never the bug: the bug
 * was which fields the read path handed over. So these tests assert from the
 * caller's side — a member calling `find`/`get` — and the companion cases
 * assert that the paths which must keep the real value still get it, because
 * a redaction that also blinded the executor would be worse than the leak.
 *
 * The redaction after-hook is reproduced here rather than imported: it is
 * defined inline inside `registerHooks`, which needs a loaded config and the
 * full service graph. That it is registered on `mcp-servers` find/get is
 * asserted structurally in `register-hooks.mcp-headers-redaction.test.ts`.
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AuthenticatedParams, MCPServer, User } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from '../utils/mcp-header-secrets.js';
import { createMCPServersService } from './mcp-servers.js';

const REAL_TOKEN = 'ghp_liveTokenThatMustNeverLeaveTheDaemon';
const REAL_API_KEY = 'dd-live-api-key-0001';

const SHARED_SERVER_ENV = {
  GITHUB_TOKEN: REAL_TOKEN,
  DATADOG_API_KEY: REAL_API_KEY,
  ALLOWED_PATHS: '/srv/projects',
  // A bare placeholder references a variable instead of carrying its value.
  TEMPLATED_TOKEN: '{{ user.env.PERSONAL_TOKEN }}',
};

async function buildDaemon() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  await runMigrations(rawDb);

  const member = (await new UsersRepository(rawDb).create({
    email: 'bob@agor.live',
    name: 'Bob',
    role: 'member',
  })) as User;

  const repo = new MCPServerRepository(rawDb);
  // Ownerless: the shape every row predating MCP ownership has, and the shape
  // that makes this a cross-user read rather than a self-read.
  const shared = await repo.create({
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { ...SHARED_SERVER_ENV },
    scope: 'global',
    source: 'user',
    enabled: true,
  });

  const app = feathers();
  app.use('mcp-servers', createMCPServersService(db));

  // Verbatim shape of `redactMCPServerSecretFields` in register-hooks.ts.
  app.service('mcp-servers').hooks({
    after: {
      find: [
        async (context: {
          params?: AuthenticatedParams;
          result?: MCPServer[] | { data: MCPServer[] };
        }) => {
          if (shouldExposeMCPServerSecrets(context.params)) return context;
          if (Array.isArray(context.result)) {
            context.result = context.result.map(redactMCPServerSecrets);
          } else if (Array.isArray(context.result?.data)) {
            // The shape `mcp-servers` find actually returns — paginated.
            context.result.data = context.result.data.map(redactMCPServerSecrets);
          }
          return context;
        },
      ],
      get: [
        async (context: { params?: AuthenticatedParams; result?: MCPServer }) => {
          if (shouldExposeMCPServerSecrets(context.params)) return context;
          if (context.result?.mcp_server_id) {
            context.result = redactMCPServerSecrets(context.result);
          }
          return context;
        },
      ],
    },
  } as never);

  // The shape a REST request from a signed-in member arrives with.
  const memberParams = {
    provider: 'rest',
    authenticated: true,
    user: { user_id: member.user_id, role: 'member' },
  } as unknown as AuthenticatedParams;

  return {
    member,
    serverId: shared.mcp_server_id,
    memberParams,
    find: (params: AuthenticatedParams) =>
      app.service('mcp-servers').find(params) as Promise<{ data: MCPServer[] }>,
    get: (params: AuthenticatedParams) =>
      app.service('mcp-servers').get(shared.mcp_server_id, params) as Promise<MCPServer>,
    patch: (data: Record<string, unknown>, params: AuthenticatedParams) =>
      app.service('mcp-servers').patch(shared.mcp_server_id, data, params) as Promise<MCPServer>,
    storedEnv: async () =>
      (await repo.findById(shared.mcp_server_id as string))?.env as Record<string, string>,
  };
}

describe('a member reading a shared MCP server', () => {
  it('does not receive another user`s env credentials from get', async () => {
    const daemon = await buildDaemon();

    const server = await daemon.get(daemon.memberParams);

    expect(server.env?.GITHUB_TOKEN).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(server.env?.DATADOG_API_KEY).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(server)).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(server)).not.toContain(REAL_API_KEY);
  });

  it('does not receive them from a list either', async () => {
    const daemon = await buildDaemon();

    const page = await daemon.find(daemon.memberParams);

    expect(page.data).toHaveLength(1);
    expect(page.data[0].env?.GITHUB_TOKEN).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(page)).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(page)).not.toContain(REAL_API_KEY);
  });

  it('can still tell a configured variable from an unset one', async () => {
    const daemon = await buildDaemon();

    const server = await daemon.get(daemon.memberParams);

    // Keys survive so the edit form renders "this server sets GITHUB_TOKEN"
    // without rendering the token itself.
    expect(Object.keys(server.env ?? {}).sort()).toEqual([
      'ALLOWED_PATHS',
      'DATADOG_API_KEY',
      'GITHUB_TOKEN',
      'TEMPLATED_TOKEN',
    ]);
  });

  it('still sees which env var a bare template points at', async () => {
    const daemon = await buildDaemon();

    const server = await daemon.get(daemon.memberParams);

    expect(server.env?.TEMPLATED_TOKEN).toBe('{{ user.env.PERSONAL_TOKEN }}');
  });
});

describe('the paths that must keep the real env value', () => {
  it('serves raw env to internal daemon calls, which is what session scoping reads', async () => {
    const daemon = await buildDaemon();

    // No `provider` — an in-process call, the shape `getMcpServersForSession`
    // and the executor-facing routes resolve through.
    const server = await daemon.get(undefined as unknown as AuthenticatedParams);

    expect(server.env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
    expect(server.env?.DATADOG_API_KEY).toBe(REAL_API_KEY);
  });

  it('serves raw env to the executor service account', async () => {
    const daemon = await buildDaemon();

    const server = await daemon.get({
      provider: 'socketio',
      authenticated: true,
      user: { user_id: 'executor', role: 'service', _isServiceAccount: true },
    } as unknown as AuthenticatedParams);

    expect(server.env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
  });

  it('serves raw env on a session-token read narrowed to that session', async () => {
    const daemon = await buildDaemon();

    // The decision `/sessions/:id/mcp-servers` makes before returning servers
    // to the executor (register-routes.ts).
    const sessionParams = {
      provider: 'socketio',
      authenticated: true,
      authentication: { strategy: 'session-token' },
      session_id: 'session-1',
      user: { user_id: 'bob', role: 'member' },
    } as unknown as AuthenticatedParams;

    expect(
      shouldExposeMCPServerSecrets(sessionParams, {
        allowSessionToken: true,
        sessionId: 'session-1',
      })
    ).toBe(true);

    const raw = await daemon.get(undefined as unknown as AuthenticatedParams);
    expect(raw.env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
  });

  it('does not overwrite the stored secret when an edit form echoes the sentinel back', async () => {
    const daemon = await buildDaemon();

    // What the UI submits after hydrating its form from a redacted read and
    // changing something unrelated.
    const redacted = await daemon.get(daemon.memberParams);
    await daemon.patch(
      { display_name: 'GitHub (prod)', env: redacted.env },
      // Patched in-process so the write-authorization hook, tested elsewhere,
      // is not what this case is about.
      undefined as unknown as AuthenticatedParams
    );

    const stored = await daemon.storedEnv();
    expect(stored.GITHUB_TOKEN).toBe(REAL_TOKEN);
    expect(stored.DATADOG_API_KEY).toBe(REAL_API_KEY);
    expect(stored.ALLOWED_PATHS).toBe('/srv/projects');
    expect(stored.TEMPLATED_TOKEN).toBe('{{ user.env.PERSONAL_TOKEN }}');
  });

  it('still accepts a genuinely rotated value', async () => {
    const daemon = await buildDaemon();

    const redacted = await daemon.get(daemon.memberParams);
    await daemon.patch(
      { env: { ...redacted.env, GITHUB_TOKEN: 'ghp_rotated' } },
      undefined as unknown as AuthenticatedParams
    );

    const stored = await daemon.storedEnv();
    expect(stored.GITHUB_TOKEN).toBe('ghp_rotated');
    expect(stored.DATADOG_API_KEY).toBe(REAL_API_KEY);
  });
});
