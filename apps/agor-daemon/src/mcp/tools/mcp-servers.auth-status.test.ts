/**
 * `agor_mcp_servers_auth_status` — what it answers, and what it answers WITH.
 *
 * Two claims live here and they are different:
 *
 *  1. The copy. This tool used to answer an unauthenticated OAuth server with
 *     "sign in from an available authentication surface" — advice no agent
 *     could act on and no user could follow when it was relayed into Slack.
 *     There is now a tool that starts the sign-in, so the recovery names it.
 *
 *  2. The verdict. `oauth_authenticated` must be the SAME answer every other
 *     surface computes for the same grant, because a disagreement is directly
 *     user-visible: the agent reads "connected" while something else offers a
 *     Connect button for a server that already works, or vice versa. That
 *     surface used to carry its own inline copy of the whole rule (server
 *     re-read, lookup key, binding, `refresh_status`, expiry). It now calls
 *     `resolveMCPOAuthGrantLiveness` and reports `live || refreshable`, which
 *     is the same verdict `oauthGrantCanAuthenticate` gives the UI's auth
 *     badge. The convergence suite below asserts the two agree state by state
 *     rather than asserting the call was made.
 *
 * The earlier version of this file stubbed `getToken` to always return `null`,
 * so the authenticated branch was never executed at all. These tests use a
 * real migrated database and real rows.
 */

import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MCPServer, MCPServerID, User, UserID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  fingerprintMCPOAuthGrantConfiguration,
  MCP_OAUTH_GRANT_BINDING_VERSION,
} from '../../services/mcp-oauth-grant-binding.js';
import {
  mcpOAuthGrantIsConnected,
  resolveMCPOAuthGrantLiveness,
} from '../../services/mcp-oauth-grant-liveness.js';
import type { McpContext } from '../server.js';
import { registerMcpServerTools, summarizeMcpServer } from './mcp-servers.js';

const HOUR = 60 * 60 * 1000;

const RESOLVED_BINDING = {
  resourceUri: 'https://mcp.example.test/mcp',
  metadataUrl: 'https://mcp.example.test/.well-known/oauth-authorization-server',
  issuer: 'https://auth.example.test',
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  redirectUri: 'https://agor.example.test/oauth/callback',
  clientId: 'client-abc',
  compatibilityMode: 'strict' as const,
};

/**
 * A daemon as this tool meets it: a real database, and an `mcp-servers`
 * service that just hands back the stored row (the tool re-reads authority
 * from the database anyway — that is the point of the shared liveness read).
 */
async function harness() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = rawDb as unknown as TenantScopeAwareDatabase;

  const user = (await new UsersRepository(rawDb).create({
    email: 'bob@agor.live',
    name: 'Bob',
    role: 'member',
  })) as User;

  const servers = new MCPServerRepository(db);
  const tokens = new UserMCPOAuthTokenRepository(db);

  const createServer = (auth: MCPServer['auth'], overrides: Record<string, unknown> = {}) =>
    servers.create({
      name: 'status-test',
      display_name: 'Status Test',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      scope: 'global',
      source: 'user',
      enabled: true,
      auth,
      ...overrides,
    } as Parameters<MCPServerRepository['create']>[0]);

  const saveBoundGrant = async (
    server: MCPServer,
    userId: UserID | null,
    input: { expiresAt?: Date | null; refreshToken?: string } = {}
  ) => {
    await tokens.saveToken(
      userId,
      server.mcp_server_id,
      {
        accessToken: 'at-1',
        expiresAt: input.expiresAt ?? null,
        refreshToken: input.refreshToken,
        clientId: RESOLVED_BINDING.clientId,
        grantBinding: {
          generation: 1,
          version: MCP_OAUTH_GRANT_BINDING_VERSION,
          fingerprint: fingerprintMCPOAuthGrantConfiguration(
            process.env.AGOR_MASTER_SECRET!,
            server,
            RESOLVED_BINDING,
            MCP_OAUTH_GRANT_BINDING_VERSION
          ),
          metadataUri: RESOLVED_BINDING.metadataUrl,
          resourceUri: RESOLVED_BINDING.resourceUri,
          issuer: RESOLVED_BINDING.issuer,
          authorizationEndpoint: RESOLVED_BINDING.authorizationEndpoint,
          tokenEndpoint: RESOLVED_BINDING.tokenEndpoint,
          redirectUri: RESOLVED_BINDING.redirectUri,
        },
      },
      user.user_id
    );
  };

  const ctx = (row: MCPServer): McpContext =>
    ({
      app: { service: () => ({ get: async () => row }) },
      db,
      userId: user.user_id,
      authenticatedUser: { user_id: user.user_id, role: 'member' },
      baseServiceParams: {
        authenticated: true,
        provider: 'mcp',
        user: { user_id: user.user_id, role: 'member' },
      },
    }) as unknown as McpContext;

  /** Drive the registered tool the way an agent reaches it. */
  const authStatus = async (row: MCPServer) => {
    let handler:
      | ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>)
      | null = null;
    registerMcpServerTools(
      {
        registerTool: (name: string, _cfg: unknown, cb: never) => {
          if (name === 'agor_mcp_servers_auth_status') handler = cb;
        },
      } as never,
      ctx(row)
    );
    if (!handler) throw new Error('tool not registered');
    const result = await (
      handler as (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
    )({ mcpServerId: row.mcp_server_id });
    return JSON.parse(result.content[0].text);
  };

  const summarize = (row: MCPServer) => summarizeMcpServer(ctx(row), row);
  const liveness = (serverId: MCPServerID) =>
    resolveMCPOAuthGrantLiveness(db, serverId, user.user_id);

  return {
    db,
    servers,
    tokens,
    user,
    createServer,
    saveBoundGrant,
    authStatus,
    summarize,
    liveness,
  };
}

describe('MCP server structured missing-auth status', () => {
  it.each([
    { type: 'bearer' as const },
    { type: 'jwt' as const, api_url: 'https://auth.example.test/token' },
  ])('reports an incomplete saved $type row as actionable needs-auth', async (auth) => {
    const h = await harness();
    const row = await h.createServer(auth as MCPServer['auth']);
    const summary = await h.summarize(row);

    expect(summary.oauth_authenticated).toBe(false);
    expect(summary.recovery).toEqual({
      category: 'authentication_required',
      action: 'save_and_retry',
      message:
        'Save the required authentication settings for this MCP server, then retry the task.',
      mcp_server_id: row.mcp_server_id,
    });
  });
});

describe('agor_mcp_servers_auth_status — actionable OAuth recovery', () => {
  it('names agor_widgets_request_oauth, with the server id already filled in', async () => {
    const h = await harness();
    const row = await h.createServer({ type: 'oauth', oauth_mode: 'per_user' });
    const payload = await h.authStatus(row);

    expect(payload.oauth_authenticated).toBe(false);
    expect(payload.instructions).toContain('agor_widgets_request_oauth');
    expect(payload.instructions).toContain(row.mcp_server_id);
    expect(payload.recovery).toMatchObject({
      category: 'authentication_required',
      action: 'reauthenticate',
      mcp_server_id: row.mcp_server_id,
    });
    expect(payload.recovery.message).toContain('agor_widgets_request_oauth');

    // The dead-end phrasing is gone, and the agent is told not to fall back to
    // asking for a pasted token.
    expect(JSON.stringify(payload)).not.toContain('available authentication surface');
    expect(payload.instructions).toMatch(/not ask the user to paste a token/i);
  });

  it('says nothing about signing in for a non-OAuth server', async () => {
    const h = await harness();
    const row = await h.createServer({ type: 'none' });
    const payload = await h.authStatus(row);
    expect(payload.instructions).toBeUndefined();
    expect(payload.recovery).toBeUndefined();
  });

  /**
   * The branch the old stub could never reach: `getToken` always returned
   * `null`, so "authenticated" was asserted nowhere and a rule that wrongly
   * reported every server as connected would have passed this file.
   */
  it('reports a live grant as authenticated, with no recovery block', async () => {
    const h = await harness();
    const row = await h.createServer({ type: 'oauth', oauth_mode: 'per_user' });
    await h.saveBoundGrant(row, h.user.user_id, { expiresAt: new Date(Date.now() + HOUR) });

    const payload = await h.authStatus(row);
    expect(payload.oauth_authenticated).toBe(true);
    expect(payload.recovery).toBeUndefined();
    expect(payload.instructions).toBeUndefined();
  });
});

/**
 * The agent-facing read and the shared grant check are ONE function (D4).
 *
 * Each case below is a state where a hand-rolled copy of the rule could
 * plausibly have drifted. The assertion is deliberately not "it returned
 * false" but "it returned exactly what the shared read returns", because the
 * defect this guards against is disagreement, not incorrectness.
 *
 * The verdict it agrees with is `mcpOAuthGrantIsConnected` — `live ||
 * refreshable`, the same disjunction `oauthGrantCanAuthenticate` computes for
 * the UI's auth badge, so one grant cannot read connected in the badge and
 * disconnected to the agent.
 *
 * Since D4.1 that verdict is also what the `oauth` widget's mint gate asks, and
 * the assertion below says so: an agent told `oauth_authenticated: true` must
 * not then be handed a Connect button for the same server. The mint gate is
 * driven from the other end of the chain, over the same states, in
 * `widgets.oauth.test.ts` — these two files together are what makes a future
 * divergence fail rather than sit invisible through a review, which is how the
 * last one survived two.
 */
describe('agent-facing auth status agrees with the shared grant check, state by state', () => {
  it.each([
    {
      state: 'a live, unexpired grant',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) =>
        h.saveBoundGrant(row, h.user.user_id, { expiresAt: new Date(Date.now() + HOUR) }),
      expectAuthenticated: true,
    },
    {
      state: 'a grant with no expiry',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) =>
        h.saveBoundGrant(row, h.user.user_id, { expiresAt: null }),
      expectAuthenticated: true,
    },
    {
      state: 'no grant at all',
      setup: async () => {},
      expectAuthenticated: false,
    },
    {
      // The state the whole widening is about. This grant's access token has
      // lapsed but its refresh token is bound and of known outcome, so the
      // inject hook's JIT refresh will make it usable without the user doing
      // anything. Reporting it as unauthenticated makes the agent offer a
      // Connect button for a server that already works, so the agent-facing
      // read counts it — same as the gateway's Slack warning, the UI's auth
      // badge via `oauthGrantCanAuthenticate`, and (since D4.1) the `oauth`
      // widget's mint short-circuit, which used to be the one surface that
      // still rendered a Connect button in exactly this state.
      state: 'an expired grant that is one refresh away from usable',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) =>
        h.saveBoundGrant(row, h.user.user_id, {
          expiresAt: new Date(Date.now() - HOUR),
          refreshToken: 'rt-1',
        }),
      expectAuthenticated: true,
    },
    {
      // Also refreshable: a refresh this daemon started is in flight against a
      // refresh token that is still on file, so the outcome is pending rather
      // than lost. `oauthGrantCanAuthenticate` counts it for the same reason.
      // An `ambiguous` row would not be — nobody knows whether its refresh
      // token was already spent — and `refreshable` excludes that state.
      state: 'a grant mid-refresh',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) => {
        await h.saveBoundGrant(row, h.user.user_id, {
          expiresAt: new Date(Date.now() + HOUR),
          refreshToken: 'rt-1',
        });
        const saved = await h.tokens.getToken(h.user.user_id, row.mcp_server_id);
        await h.tokens.setStandaloneRefreshState(
          h.user.user_id,
          row.mcp_server_id,
          {
            grantGeneration: saved!.grant_generation,
            refreshGeneration: saved!.refresh_generation,
            grantBindingFingerprint: saved!.grant_binding_fingerprint,
          },
          'idle',
          'refreshing'
        );
      },
      expectAuthenticated: true,
    },
    {
      state: 'a grant whose server configuration moved under it',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) => {
        await h.saveBoundGrant(row, h.user.user_id, { expiresAt: new Date(Date.now() + HOUR) });
        await h.servers.update(row.mcp_server_id, { url: 'https://elsewhere.example.test/mcp' });
      },
      expectAuthenticated: false,
    },
    {
      // The lookup-key split: a shared server must not be satisfied by the
      // caller's own per-user row.
      state: 'a per-user grant on a server that is now shared',
      setup: async (h: Awaited<ReturnType<typeof harness>>, row: MCPServer) => {
        await h.saveBoundGrant(row, h.user.user_id, { expiresAt: new Date(Date.now() + HOUR) });
        await h.servers.update(row.mcp_server_id, {
          auth: { type: 'oauth', oauth_mode: 'shared' },
        });
      },
      expectAuthenticated: false,
    },
  ])('$state', async ({ setup, expectAuthenticated }) => {
    const h = await harness();
    const row = await h.createServer({ type: 'oauth', oauth_mode: 'per_user' });
    await setup(h, row);

    // Re-read: some cases mutate the server row out from under the caller,
    // which is exactly the situation the tool is handed a stale row in.
    const current = (await h.servers.findById(row.mcp_server_id)) as MCPServer;
    const summary = await h.summarize(current);
    const gate = await h.liveness(row.mcp_server_id);

    expect(summary.oauth_authenticated).toBe(expectAuthenticated);
    // The shared verdict, by name rather than by a re-spelled disjunction: the
    // mint gate, the widget's resolve gate, the Slack card and the gateway's
    // warning all call this same function, so re-deriving it here would let
    // this file keep passing while they drifted.
    expect(summary.oauth_authenticated).toBe(mcpOAuthGrantIsConnected(gate));
  });
});
