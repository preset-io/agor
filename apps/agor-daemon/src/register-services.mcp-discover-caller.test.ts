import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  MCPServerRepository,
  runMigrations,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPDiscoveryRequest, TenantID, UserID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';

// Exercise the registered service, real authorization and persistence; only
// replace the remote capability client. Denials must precede provider work.
const connect = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connect;
    async close() {}
    async listTools() {
      return { tools: [{ name: 'discovered', inputSchema: { type: 'object' } }] };
    }
    async listResources() {
      return { resources: [] };
    }
    async listPrompts() {
      return { prompts: [] };
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

const TENANT = 'discovery-tenant-a' as TenantID;
const denial = {
  success: false,
  error: 'Access denied: only an admin or the server owner can discover this MCP server',
};

async function createHarness() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb);
  const users = new UsersRepository(rawDb);
  const owner = await users.create({ email: 'owner@example.test', role: 'member' });
  const admin = await users.create({ email: 'admin@example.test', role: 'admin' });
  const unrelated = await users.create({ email: 'unrelated@example.test', role: 'member' });
  const repository = new MCPServerRepository(rawDb);
  const saved = await repository.create({
    name: 'private-discovery',
    url: 'https://mcp.example.test/mcp',
    transport: 'http',
    scope: 'session',
    owner_user_id: owner.user_id as UserID,
  });
  const shared = await repository.create({
    name: 'shared-discovery',
    url: 'https://mcp.example.test/shared',
    transport: 'http',
    scope: 'global',
  });
  const app = feathers() as Application;
  await runWithTenantDatabaseScope(db, TENANT, () =>
    registerMCPServices({
      db,
      app,
      config: {} as RegisterServicesContext['config'],
      jwtSecret: 'discovery-test-jwt',
      daemonUrl: 'http://127.0.0.1:3030',
      bundledUiAvailable: false,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      // Intentionally leave userless external calls intact: the authorization
      // boundary must fail closed even without the upstream authentication hook.
      requireAuth: async (context) => context,
      deployment: {} as RegisterServicesContext['deployment'],
    })
  );
  const params = (user?: AuthenticatedParams['user']): AuthenticatedParams => ({
    provider: 'rest',
    user,
    tenant: { tenant_id: TENANT, source: 'auth_claim' },
  });
  const discover = (data: MCPDiscoveryRequest, caller: AuthenticatedParams) =>
    app.service('mcp-servers/discover').create(data, caller);
  return { rawDb, repository, owner, admin, unrelated, saved, shared, params, discover };
}

describe('saved MCP discovery caller authority', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    vi.stubEnv('AGOR_MASTER_SECRET', 'discovery-caller-test-master-secret');
    connect.mockClear();
    h = await createHarness();
  });

  afterEach(() => {
    (h?.rawDb as unknown as { $client: { close(): void } })?.$client.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // Both paths must apply discovery authorization, including a submitted
  // form snapshot accompanying a saved ID.
  describe.each([false, true])('inline configuration: %s', (inline) => {
    const request = (id: string): MCPDiscoveryRequest => ({
      mcp_server_id: id,
      ...(inline ? { url: 'https://untrusted.example.test/mcp', transport: 'http' } : {}),
    });

    it('denies a service account before capability capture or provider work', async () => {
      const capture = vi.spyOn(UsersRepository.prototype, 'getDiscoveryAuthorityProjection');
      const caller = h.params({
        user_id: 'executor-service',
        role: 'service',
        _isServiceAccount: true,
      } as unknown as NonNullable<AuthenticatedParams['user']>);
      for (const server of [h.saved, h.shared]) {
        await expect(h.discover(request(server.mcp_server_id), caller)).resolves.toEqual(denial);
        expect(await h.repository.findById(server.mcp_server_id)).toEqual(server);
      }
      expect(capture).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it.each(['owner', 'admin'] as const)(
      'allows the %s and persists discovered capabilities',
      async (kind) => {
        const target = kind === 'owner' ? h.saved : h.shared;
        await expect(
          h.discover(request(target.mcp_server_id), h.params(h[kind]))
        ).resolves.toMatchObject({ success: true, capabilities: { tools: 1 } });
        expect(connect).toHaveBeenCalledOnce();
        expect(await h.repository.findById(target.mcp_server_id)).toMatchObject({
          tools: [{ name: 'discovered' }],
        });
      }
    );

    it('denies an unrelated member even when the row is visible', async () => {
      await expect(
        h.discover(request(h.shared.mcp_server_id), h.params(h.unrelated))
      ).resolves.toEqual(denial);
      await expect(
        h.discover(request(h.saved.mcp_server_id), h.params(h.unrelated))
      ).resolves.toMatchObject({ success: false });
      expect(connect).not.toHaveBeenCalled();
    });

    it.each(['rest', 'socketio'])('fails closed for a userless %s caller', async (provider) => {
      await expect(
        h.discover(request(h.saved.mcp_server_id), { ...h.params(), provider })
      ).rejects.toThrow(/authentication required/i);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  it('does not read caller authority from query or body fields', async () => {
    const spoof = {
      provider: undefined,
      user: { ...h.admin, _isServiceAccount: true },
      owner_user_id: h.unrelated.user_id,
      tenant: { tenant_id: 'spoofed-tenant', source: 'auth_claim' },
    };
    const data = { mcp_server_id: h.shared.mcp_server_id, ...spoof };
    await expect(h.discover(data, { ...h.params(h.unrelated), query: spoof })).resolves.toEqual(
      denial
    );
    await expect(h.discover(data, { ...h.params(), query: spoof })).rejects.toThrow(
      /authentication required/i
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects conflicting tenant authority before loading even an admin-visible saved ID', async () => {
    // SQLite does not prove PostgreSQL RLS. This pins the changed endpoint's
    // short-scope boundary: tenant B cannot enter A's scope using A's ID/params.
    const lookup = vi.spyOn(MCPServerRepository.prototype, 'findById');
    await expect(
      runWithTenantContext('discovery-tenant-b', () =>
        h.discover({ mcp_server_id: h.saved.mcp_server_id }, h.params(h.admin))
      )
    ).resolves.toMatchObject({ success: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not substitute a query/body tenant for missing trusted tenant context', async () => {
    const spoof = { tenant: { tenant_id: TENANT, source: 'auth_claim' }, tenant_id: TENANT };
    await expect(
      h.discover(
        { mcp_server_id: h.saved.mcp_server_id, ...spoof },
        { ...h.params(h.admin), tenant: undefined, query: spoof }
      )
    ).resolves.toMatchObject({ success: false });
    expect(connect).not.toHaveBeenCalled();
    expect(await h.repository.findById(h.saved.mcp_server_id)).toEqual(h.saved);
  });
});
