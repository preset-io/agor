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
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
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
  permission_disclosure: 'Reads public GitHub repository content only.',
} as unknown as MCPCatalogEntry;

const CONNECT_REQUEST = {
  catalog_key: DEEPWIKI,
  branch_id: 'branch-1',
  agentic_tool: 'claude-code' as const,
  acknowledged_disclosure: 'Reads public GitHub repository content only.',
};

/**
 * The daemon as connect meets it: the real `mcp-servers` service carrying the
 * real write hook, with the services connect merely calls through stood in for.
 *
 * The hook is attached here rather than by `registerHooks`, so these tests
 * describe what a create does once it reaches the hook, not that the daemon
 * puts it there. That second claim is asserted separately at the bottom of
 * this file, against the production registration itself.
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
      // The publisher, not the protocol word `com.deepwiki/mcp` ends with.
      name: 'deepwiki',
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

  // Pinned through connect rather than only against the authorizer: this is
  // the path a user reaches by clicking Connect, and the sentence it produces
  // is the one they read. Configuring a server directly still says so.
  it('refuses a member under the default use_existing_only, writing nothing', async () => {
    const { connect, installedServers } = await buildDaemon('use_existing_only');

    await expect(connect()).rejects.toThrow(/this entry cannot be installed/);
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

    await expect(connectAs(member, 'member')).rejects.toThrow(/this entry cannot be installed/);
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

/**
 * Take the `before.create` chain off `mcp-servers` as `registerHooks` — the
 * production registration — actually leaves it.
 *
 * The app is a stub that records what each service is registered with, the
 * approach `register-hooks.test.ts` already uses for the schedules hooks. The
 * database is real, because the ownership hook resolves `mcp_member_policy`
 * and reads rows; everything else `registerHooks` wants decides nothing here.
 *
 * Only `before.create` is collected: the tenant-path loops register `all`,
 * `around`, and `after` hooks on `mcp-servers` too, and none of them are the
 * claim under test.
 */
function captureRegisteredMcpServerCreateHooks(
  db: TenantScopeAwareDatabase
): Array<(context: McpServerWriteHookContext) => Promise<unknown>> {
  const captured: Array<(context: McpServerWriteHookContext) => Promise<unknown>> = [];
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: { create?: unknown[] } }) {
          if (path.replace(/^\//, '') !== 'mcp-servers') return;
          captured.push(
            ...((hooks.before?.create ?? []) as Array<
              (context: McpServerWriteHookContext) => Promise<unknown>
            >)
          );
        },
      };
    },
    use() {},
    publish() {},
  };

  registerHooks({
    db,
    app: app as unknown as RegisterHooksContext['app'],
    config: { database: { dialect: 'sqlite' } } as RegisterHooksContext['config'],
    jwtSecret: 'mcp-server-wiring-test-secret',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    deployment: { mode: 'standalone' } as RegisterHooksContext['deployment'],
  });

  return captured;
}

describe('the write hook this seam depends on', () => {
  /**
   * The assertion the rest of this file cannot make: not that the guard decides
   * correctly, but that `registerHooks` puts it on the path a create travels.
   * Every other test here — and every test in
   * `mcp-server-authorization.test.ts` — builds the hook itself, so all of them
   * keep passing if the `create: [authorizeMcpServerWriteHook]` line is deleted
   * from `register-hooks.ts`. These two do not: they run whatever that file
   * registered, and nothing else.
   *
   * That distinction is the bug this suite exists for. The unowned marketplace
   * install shipped because a guard was well covered in isolation and never
   * checked to be reachable.
   */
  const standUpDaemonHooks = async (policy: MCPMemberPolicy = 'allow_crud') => {
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = rawDb as unknown as TenantScopeAwareDatabase;
    await runMigrations(rawDb);
    await setMcpMemberPolicy(db, policy, undefined, null);

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

    const registeredHooks = captureRegisteredMcpServerCreateHooks(db);
    const createAs = async (caller: User, data: Record<string, unknown>) => {
      const context = {
        method: 'create',
        data,
        params: {
          provider: 'rest',
          user: { user_id: caller.user_id, role: 'member' },
        } as unknown as AuthenticatedParams,
      } satisfies McpServerWriteHookContext;
      for (const hook of registeredHooks) await hook(context);
      return context;
    };

    return { bob, mallory, createAs };
  };

  it('is registered on mcp-servers create by registerHooks, not just constructible', async () => {
    const { bob, mallory, createAs } = await standUpDaemonHooks();

    await expect(
      createAs(mallory, { transport: 'http', owner_user_id: bob.user_id })
    ).rejects.toThrow(/only create MCP servers owned by yourself/);
  });

  it('runs as the registered chain, not as a blanket denier', async () => {
    // Guards the test above: a chain that rejected everything would satisfy it
    // just as well as the real hook. This one only passes if what
    // `registerHooks` registered lets a legitimate create through *and* stamps
    // the owner the way `allow_private_only` requires.
    const { bob, createAs } = await standUpDaemonHooks('allow_private_only');

    const context = await createAs(bob, { transport: 'http' });

    expect((context.data as { owner_user_id?: string }).owner_user_id).toBe(bob.user_id);
  });
});
