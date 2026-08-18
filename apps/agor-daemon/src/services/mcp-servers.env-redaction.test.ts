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
 * These drive the real `redactMCPServerSecretFields` hook against a real
 * service and a real database. Booting `registerHooks` itself would need a
 * loaded config and the full service graph, so the one thing left to a
 * source-level assertion is which methods the hook is registered on — pinned
 * in `register-hooks.mcp-headers-redaction.test.ts`, and the reason `remove`
 * being absent from that list was invisible for as long as it was.
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
import { redactMCPServerSecretFields } from '../register-hooks.js';
import { shouldExposeMCPServerSecrets } from '../utils/mcp-header-secrets.js';
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

  /**
   * A direct service call resolves to `context.result`, but a socket client
   * receives `returnedCtx.dispatch || returnedCtx.result`
   * (@feathersjs/transport-commons socket/utils.js). Recording the finished
   * context lets the assertions below use the transport's formula instead of
   * the in-process one — without it, a `dispatch` set where it should not be
   * is invisible to every test.
   */
  let lastContext: { dispatch?: unknown; result?: unknown } = {};
  const recordFinishedContext = async (context: { dispatch?: unknown; result?: unknown }) => {
    lastContext = context;
    return context;
  };

  // The real production hook, not a reproduction of it. Which methods it is
  // registered on is pinned in `register-hooks.mcp-headers-redaction.test.ts`.
  app.service('mcp-servers').hooks({
    after: {
      find: [redactMCPServerSecretFields, recordFinishedContext],
      get: [redactMCPServerSecretFields, recordFinishedContext],
      create: [redactMCPServerSecretFields, recordFinishedContext],
      patch: [redactMCPServerSecretFields, recordFinishedContext],
      update: [redactMCPServerSecretFields, recordFinishedContext],
      remove: [redactMCPServerSecretFields, recordFinishedContext],
    },
  } as never);

  /** What a socket client would receive as the response to the last call. */
  const overSocket = async <T>(call: Promise<unknown>): Promise<T> => {
    await call;
    return (lastContext.dispatch ?? lastContext.result) as T;
  };

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
    remove: (params: AuthenticatedParams) =>
      app.service('mcp-servers').remove(shared.mcp_server_id, params) as Promise<MCPServer>,
    create: (data: Record<string, unknown>, params: AuthenticatedParams) =>
      app.service('mcp-servers').create(data, params) as Promise<MCPServer>,
    getOverSocket: (params: AuthenticatedParams) =>
      overSocket<MCPServer>(app.service('mcp-servers').get(shared.mcp_server_id, params)),
    findOverSocket: (params: AuthenticatedParams) =>
      overSocket<{ data: MCPServer[] }>(app.service('mcp-servers').find(params)),
    update: (data: Record<string, unknown>, params: AuthenticatedParams) =>
      app.service('mcp-servers').update(shared.mcp_server_id, data, params) as Promise<MCPServer>,
    /**
     * What the socket transport would actually put on the wire for each
     * emitted event.
     *
     * Feathers emits `(element, context)` where `element` comes from
     * `context.result`, but @feathersjs/transport-commons sends
     * `channel.dataFor(connection) || context.dispatch || context.result`.
     * Asserting on `element` would therefore miss a raw `dispatch` entirely —
     * which is exactly how the privileged-caller broadcast stayed invisible.
     */
    captureBroadcasts: (event: 'created' | 'updated' | 'patched' | 'removed') => {
      const sent: MCPServer[] = [];
      app
        .service('mcp-servers')
        .on(event, (_element: MCPServer, hook: { dispatch?: MCPServer; result?: MCPServer }) => {
          sent.push((hook.dispatch ?? hook.result) as MCPServer);
        });
      return sent;
    },
    storedEnv: async () =>
      (await repo.findById(shared.mcp_server_id as string))?.env as Record<string, string>,
    storedServer: () => repo.findById(shared.mcp_server_id as string),
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

  it('does not receive them from the deleted row a delete hands back', async () => {
    // `DrizzleService.remove` loads the whole row before deleting so it can
    // return it. A delete is not an exemption from redaction.
    const daemon = await buildDaemon();

    const deleted = await daemon.remove(daemon.memberParams);

    expect(deleted.env?.GITHUB_TOKEN).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(deleted)).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(deleted)).not.toContain(REAL_API_KEY);
  });

  it('does not receive them in the removed event broadcast to every connection', async () => {
    // The same object becomes the `removed` payload. `mcp-servers` events go
    // to the tenant-wide authenticated channel, so an unredacted one hands
    // the credentials to every connected member at once.
    const daemon = await buildDaemon();
    const broadcast = daemon.captureBroadcasts('removed');

    await daemon.remove(daemon.memberParams);

    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].env?.GITHUB_TOKEN).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(broadcast)).not.toContain(REAL_TOKEN);
    expect(JSON.stringify(broadcast)).not.toContain(REAL_API_KEY);
  });

  it('still sees which env var a bare template points at', async () => {
    const daemon = await buildDaemon();

    const server = await daemon.get(daemon.memberParams);

    expect(server.env?.TEMPLATED_TOKEN).toBe('{{ user.env.PERSONAL_TOKEN }}');
  });
});

/**
 * The broadcast audience is not the caller, so nothing about the caller can
 * entitle it to secrets. These are the cases the member-perspective tests
 * above sail straight past: when the writer is trusted, `context.result`
 * stays raw by design, and the event is built from it unless `dispatch` says
 * otherwise.
 */
describe('a privileged write still broadcasts a redacted row', () => {
  const INTERNAL = undefined as unknown as AuthenticatedParams;
  const SERVICE_ACCOUNT = {
    provider: 'socketio',
    authenticated: true,
    user: { user_id: 'executor', role: 'service', _isServiceAccount: true },
  } as unknown as AuthenticatedParams;

  const PRIVILEGED: Array<[string, AuthenticatedParams]> = [
    ['an internal in-process call', INTERNAL],
    ['the executor service account', SERVICE_ACCOUNT],
  ];

  describe.each(PRIVILEGED)('%s', (_label, params) => {
    it('removing broadcasts a redacted row while the caller keeps the real one', async () => {
      const daemon = await buildDaemon();
      const broadcast = daemon.captureBroadcasts('removed');

      const returnedToCaller = await daemon.remove(params);

      expect(broadcast).toHaveLength(1);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_TOKEN);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_API_KEY);
      // The caller's own entitlement is untouched — this is what keeps
      // session scoping and stdio startup working.
      expect(returnedToCaller.env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
    });

    it('patching broadcasts a redacted row', async () => {
      const daemon = await buildDaemon();
      const broadcast = daemon.captureBroadcasts('patched');

      await daemon.patch({ display_name: 'GitHub (prod)' }, params);

      expect(broadcast).toHaveLength(1);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_TOKEN);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_API_KEY);
    });

    it('updating broadcasts a redacted row', async () => {
      const daemon = await buildDaemon();
      const broadcast = daemon.captureBroadcasts('updated');

      await daemon.update({ name: 'github', transport: 'stdio', command: 'npx' }, params);

      expect(broadcast).toHaveLength(1);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_TOKEN);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_API_KEY);
    });

    it('creating broadcasts a redacted row', async () => {
      const daemon = await buildDaemon();
      const broadcast = daemon.captureBroadcasts('created');

      await daemon.create(
        {
          name: 'second',
          transport: 'stdio',
          command: 'npx',
          env: { OTHER_TOKEN: REAL_TOKEN },
          scope: 'global',
          source: 'user',
          enabled: true,
        },
        params
      );

      expect(broadcast).toHaveLength(1);
      expect(JSON.stringify(broadcast)).not.toContain(REAL_TOKEN);
    });
  });

  it('leaves find and get alone, since neither emits anything to redact for', async () => {
    // `dispatch` is also what the socket transport hands back to the caller
    // of a method. On a non-emitting method it would buy no broadcast safety
    // and would strip the values out of the executor's own reads — which is
    // how the executor loads MCP config. Asserted through the transport's
    // formula, so a `dispatch` set here is not invisible.
    const daemon = await buildDaemon();

    const viaGet = await daemon.getOverSocket(SERVICE_ACCOUNT);
    const viaFind = await daemon.findOverSocket(SERVICE_ACCOUNT);

    expect(viaGet.env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
    expect(viaFind.data[0].env?.GITHUB_TOKEN).toBe(REAL_TOKEN);
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

  it('does not resurrect a variable that a concurrent edit deleted', async () => {
    // Two windows. The first hydrates its form and holds the sentinel. The
    // second deletes GITHUB_TOKEN. Then the first saves an unrelated change,
    // echoing the stale sentinel back. Persisting it would recreate
    // GITHUB_TOKEN holding `••••••••` — every executor would then launch with
    // a credential that is silently bogus, which is worse than either the
    // deletion or the original value.
    const daemon = await buildDaemon();

    const staleForm = await daemon.get(daemon.memberParams);

    const { GITHUB_TOKEN: _dropped, ...withoutToken } = staleForm.env ?? {};
    await daemon.patch({ env: withoutToken }, undefined as unknown as AuthenticatedParams);
    expect(await daemon.storedEnv()).not.toHaveProperty('GITHUB_TOKEN');

    await daemon.patch(
      { display_name: 'GitHub (prod)', env: staleForm.env },
      undefined as unknown as AuthenticatedParams
    );

    const stored = await daemon.storedEnv();
    expect(stored).not.toHaveProperty('GITHUB_TOKEN');
    expect(JSON.stringify(stored)).not.toContain(MCP_HEADER_REDACTED_SENTINEL);
    // The rest of the row is untouched by the dropped key.
    expect(stored.DATADOG_API_KEY).toBe(REAL_API_KEY);
  });

  it('never lets the sentinel reach the database on any write', async () => {
    // The invariant the two cases above are instances of. Once the sentinel
    // is stored it looks like a real value to the next restore, so the
    // corruption would be self-perpetuating.
    const daemon = await buildDaemon();

    await daemon.patch(
      { env: { BRAND_NEW: MCP_HEADER_REDACTED_SENTINEL } },
      undefined as unknown as AuthenticatedParams
    );

    const stored = await daemon.storedServer();
    expect(JSON.stringify(stored)).not.toContain(MCP_HEADER_REDACTED_SENTINEL);
  });
});
