/**
 * What a marketplace install leaves in the database, driven end to end.
 *
 * Every other test of this seam calls `authorizeMcpServerWrite` directly, which
 * proves the guard decides correctly and nothing else. It cannot tell whether
 * the guard is wired to the service connect actually writes through, nor what
 * `mcp_servers` ends up holding — and both of those are the security property.
 * So this drives `mcp-catalog/connect` the way an authenticated member reaches
 * it, through the real `mcp-servers` service, the real write hook, and a real
 * database, then reads the row back.
 *
 * Only the catalog, sessions, and the session attachment are stood in for:
 * they decide nothing about ownership, and a session needs a branch, a repo,
 * and a worktree that have no bearing on what is under test.
 */

import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPMemberPolicy,
  MCPServer,
  User,
  UserRole,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpServerWriteAuthorizationHook,
  type McpServerWriteHookContext,
} from '../utils/mcp-server-authorization.js';
import { createMCPCatalogConnectService } from './mcp-catalog-connect.js';
import { createMCPServersService } from './mcp-servers.js';

const { probeRemoteAuthType } = vi.hoisted(() => ({ probeRemoteAuthType: vi.fn() }));
vi.mock('@agor/core/mcp-catalog', () => ({ probeRemoteAuthType }));

const DEEPWIKI = 'com.deepwiki/mcp';

const CURATED = {
  catalog_entry_id: '00000000-0000-7000-8000-0000000ce001',
  name: DEEPWIKI,
  title: 'DeepWiki',
  transport: 'streamable-http',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  has_remote: true,
  has_package: false,
  curated: true,
  verified: false,
  probed_auth_type: 'none',
} as unknown as MCPCatalogEntry;

const CONNECT_REQUEST = {
  catalog_key: DEEPWIKI,
  branch_id: 'branch-1',
  agentic_tool: 'claude-code' as const,
};

/**
 * The daemon as connect meets it: the real `mcp-servers` service carrying the
 * real write hook, with the services connect merely calls through stood in for.
 */
async function buildDaemon(policy: MCPMemberPolicy, role: UserRole = 'member') {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  await runMigrations(rawDb);
  await setMcpMemberPolicy(db, policy, undefined, null);

  const users = new UsersRepository(rawDb);
  const user = (await users.create({ email: 'bob@agor.live', name: 'Bob', role })) as User;

  const app = feathers();
  app.use('mcp-servers', createMCPServersService(db));
  app.service('mcp-servers').hooks({
    before: {
      create: [createMcpServerWriteAuthorizationHook(db) as never],
    },
  } as never);
  app.use('mcp-catalog', {
    async get() {
      return CURATED;
    },
  } as never);
  app.use('sessions', {
    async create(data: Record<string, unknown>) {
      return { ...data, session_id: 'session-1' };
    },
  } as never);
  app.use('/sessions/:id/mcp-servers', {
    async create(data: unknown) {
      return data;
    },
  } as never);

  // The shape a REST request arrives with: an external provider and the
  // authenticated caller. Connect passes it straight through to its own writes.
  const paramsFor = (caller: User, callerRole: UserRole) =>
    ({
      provider: 'rest',
      authenticated: true,
      user: { user_id: caller.user_id, role: callerRole },
    }) as unknown as AuthenticatedParams;

  const connectAs = (caller: User, callerRole: UserRole) =>
    createMCPCatalogConnectService(app).create(CONNECT_REQUEST, paramsFor(caller, callerRole));
  const connect = () => connectAs(user, role);
  const installedServers = () => new MCPServerRepository(rawDb).findAll({});
  const addUser = (email: string, addedRole: UserRole) =>
    users.create({ email, name: email, role: addedRole }) as Promise<User>;

  return { user, connect, connectAs, addUser, installedServers };
}

describe('marketplace install, as it lands in the database', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
  });

  it('leaves the install owned by the member who connected it', async () => {
    const { user, connect, installedServers } = await buildDaemon('allow_crud');

    await connect();

    const [server] = await installedServers();
    expect(server).toMatchObject({
      name: 'mcp',
      scope: 'session',
      catalog_entry_name: DEEPWIKI,
      owner_user_id: user.user_id,
    });
  });

  it('leaves an admin’s install owned by that admin, not shared with the tenant', async () => {
    const { user, connect, installedServers } = await buildDaemon('allow_crud', 'admin');

    await connect();

    const [server] = await installedServers();
    expect(server?.owner_user_id).toBe(user.user_id);
  });

  it('stamps the owner under allow_private_only too', async () => {
    const { user, connect, installedServers } = await buildDaemon('allow_private_only');

    await connect();

    const [server] = await installedServers();
    expect(server?.owner_user_id).toBe(user.user_id);
  });

  it('refuses a member under the default use_existing_only, writing nothing', async () => {
    const { connect, installedServers } = await buildDaemon('use_existing_only');

    await expect(connect()).rejects.toThrow(/does not allow members to configure MCP servers/);
    await expect(installedServers()).resolves.toHaveLength(0);
  });

  it('does not hand one user’s install to the next caller through reuse', async () => {
    // The shape a manual test found: an admin connects an entry, then a member
    // connects the same entry under the policy that forbids them configuring
    // anything — and succeeds. Nothing bypassed the policy gate; the member
    // never reached it, because `findExistingInstall` matches anything usable
    // by them and an unowned row is usable by everyone. So the admin's install
    // became the member's, and `use_existing_only` looked porous when what had
    // actually leaked was the install.
    const {
      user: admin,
      connectAs,
      addUser,
      installedServers,
    } = await buildDaemon('use_existing_only', 'admin');

    await connectAs(admin, 'admin');
    const member = await addUser('bob@member.agor.live', 'member');

    await expect(connectAs(member, 'member')).rejects.toThrow(
      /does not allow members to configure MCP servers/
    );
    const servers = await installedServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.owner_user_id).toBe(admin.user_id);
  });

  it('gives each user their own install of the same entry', async () => {
    const { user: first, connectAs, addUser, installedServers } = await buildDaemon('allow_crud');
    const second = await addUser('second@agor.live', 'member');

    await connectAs(first, 'member');
    await connectAs(second, 'member');

    const owners = (await installedServers()).map((server) => server.owner_user_id).sort();
    expect(owners).toEqual([first.user_id, second.user_id].sort());
  });

  it('reuses the caller’s own install rather than adding a second row', async () => {
    const { user, connect, installedServers } = await buildDaemon('allow_crud');

    const first = (await connect()) as { mcp_server: MCPServer };
    const second = (await connect()) as {
      mcp_server: MCPServer;
      reused_existing_server: boolean;
    };

    expect(second.reused_existing_server).toBe(true);
    expect(second.mcp_server.mcp_server_id).toBe(first.mcp_server.mcp_server_id);
    const servers = await installedServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.owner_user_id).toBe(user.user_id);
  });
});

describe('the write hook this seam depends on', () => {
  it('is the one the mcp-servers service is registered with', async () => {
    // A stand-in for the assertion the other tests cannot make: that the hook
    // is reached at all. If `mcp-servers` were ever registered without it, the
    // create below would persist the client's own owner_user_id.
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = rawDb as unknown as TenantScopeAwareDatabase;
    await runMigrations(rawDb);
    await setMcpMemberPolicy(db, 'allow_crud', undefined, null);

    const users = new UsersRepository(rawDb);
    const bob = (await users.create({
      email: 'bob@agor.live',
      name: 'Bob',
      role: 'member',
    })) as User;
    const mallory = (await users.create({
      email: 'mallory@agor.live',
      name: 'Mallory',
      role: 'member',
    })) as User;

    const hook = createMcpServerWriteAuthorizationHook(db);
    const context = {
      method: 'create',
      data: { transport: 'http', owner_user_id: bob.user_id },
      params: {
        provider: 'rest',
        user: { user_id: mallory.user_id, role: 'member' },
      } as unknown as AuthenticatedParams,
    } satisfies McpServerWriteHookContext;

    await expect(hook(context)).rejects.toThrow(/only create MCP servers owned by yourself/);
  });
});
