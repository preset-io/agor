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
  MCPCatalogCandidateRepository,
  MCPServerRepository,
  runMigrations,
  setMcpMemberPolicy,
  shortId,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPMemberPolicy,
  MCPServer,
  User,
  UserID,
  UserRole,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { createRegisteredMCPCatalogConnectService } from '../register-routes.js';
import {
  createMcpServerWriteAuthorizationHook,
  type McpServerWriteHookContext,
} from '../utils/mcp-server-authorization.js';
import { createMCPCatalogConnectService } from './mcp-catalog-connect.js';
import { isMCPOAuthGrantAuthorizedForServer } from './mcp-oauth-grant-authority.js';
import { createMCPServersService } from './mcp-servers.js';

const { probeRemoteAuthType } = vi.hoisted(() => ({ probeRemoteAuthType: vi.fn() }));
vi.mock('@agor/core/mcp-catalog', () => ({ probeRemoteAuthType }));

const DEEPWIKI = 'com.deepwiki/mcp';

const CURATED = {
  name: DEEPWIKI,
  title: 'DeepWiki',
  transport: 'streamable-http',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  has_remote: true,
  has_package: false,
  auth_type: 'none',
  permission_disclosure: 'Reads public GitHub repository content only.',
} as unknown as MCPCatalogEntry;

/**
 * A caller who holds no OAuth grant anywhere, for the tests about installing
 * rather than about reuse. Reuse asks this first and stops when it says so.
 */
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
async function buildDaemon(
  policy: MCPMemberPolicy,
  role: UserRole = 'member',
  catalogEntry: MCPCatalogEntry = CURATED
) {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  await runMigrations(rawDb);
  await setMcpMemberPolicy(db, policy, undefined, null);

  const users = new UsersRepository(rawDb);
  const user = (await users.create({ email: 'bob@agor.live', name: 'Bob', role })) as User;

  const app = feathers();
  app.use('mcp-servers', createMCPServersService(db));
  const registeredHooks = captureRegisteredMcpServerCreateHooks(db);
  app.service('mcp-servers').hooks({
    before: {
      create: registeredHooks.create as never,
    },
  } as never);
  app.use('mcp-catalog', {
    async get() {
      return catalogEntry;
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
  const paramsFor = (caller: User, callerRole: UserRole, presentedUserId = caller.user_id) =>
    ({
      provider: 'rest',
      authenticated: true,
      user: { user_id: presentedUserId, role: callerRole },
    }) as unknown as AuthenticatedParams;

  const connectAs = (caller: User, callerRole: UserRole, presentedUserId = caller.user_id) =>
    createRegisteredMCPCatalogConnectService(app, db).create(
      CONNECT_REQUEST,
      paramsFor(caller, callerRole, presentedUserId)
    );
  const connect = () => connectAs(user, role);
  const serverRepository = new MCPServerRepository(rawDb);
  const installedServers = () => serverRepository.findAll({});
  const seedServer = (server: Parameters<MCPServerRepository['create']>[0]) =>
    serverRepository.create(server);
  const addUser = (email: string, addedRole: UserRole, user_id?: UserID) =>
    users.create({ email, name: email, role: addedRole, user_id }) as Promise<User>;

  return { user, connect, connectAs, addUser, installedServers, seedServer };
}

describe('marketplace install, as it lands in the database', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('none');
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

  it('resolves a short authenticated user ID at the production route boundary', async () => {
    const { user, connectAs, installedServers } = await buildDaemon('allow_crud');

    const result = await connectAs(user, 'member', shortId(user.user_id));

    const [server] = await installedServers();
    expect(server?.owner_user_id).toBe(user.user_id);
    expect(result.mcp_server.owner_user_id).toBe(user.user_id);
    expect(result.session).toMatchObject({ status: 'idle' });
    expect(JSON.stringify(result)).not.toContain('oauth_access_token');
    expect(JSON.stringify(result)).not.toContain('oauth_refresh_token');
  });

  it('accepts the canonical legacy UUID user ID shape deployed in production', async () => {
    const { connectAs, addUser, installedServers } = await buildDaemon('allow_crud');
    const legacyUserId = '707bae66-dda5-4c01-9136-a5cda16e048e' as UserID;
    const legacy = await addUser('legacy-production-shape@agor.live', 'member', legacyUserId);

    await connectAs(legacy, 'member');

    expect(
      (await installedServers()).find((row) => row.owner_user_id === legacyUserId)
    ).toMatchObject({
      owner_user_id: legacyUserId,
      catalog_entry_name: DEEPWIKI,
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

  it('authoritatively replaces stale same-type OAuth fields on a reused catalog install', async () => {
    const oauthEntry = { ...CURATED, auth_type: 'oauth' } as MCPCatalogEntry;
    const { user, connect, installedServers, seedServer } = await buildDaemon(
      'allow_crud',
      'member',
      oauthEntry
    );
    await seedServer({
      name: 'deepwiki',
      display_name: 'DeepWiki',
      transport: 'http',
      url: CURATED.remote_url,
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_authorization_url: 'https://stale.example/authorize',
        oauth_token_url: 'https://stale.example/token',
        oauth_client_secret: 'stale-client-secret',
        oauth_scope: 'stale:read stale:write',
        // This is the one catalog reconciliation override the operator chose
        // explicitly and is allowed to retain.
        oauth_compatibility_mode: 'legacy',
      },
      scope: 'session',
      source: 'catalog',
      catalog_entry_name: DEEPWIKI,
      owner_user_id: user.user_id as UserID,
      enabled: true,
    });
    probeRemoteAuthType.mockResolvedValueOnce('oauth');

    const result = (await connect()) as {
      reused_existing_server: boolean;
      mcp_server: MCPServer;
    };

    expect(result.reused_existing_server).toBe(true);
    const [stored] = await installedServers();
    expect(stored?.auth).toEqual({
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_compatibility_mode: 'legacy',
    });
    expect(JSON.stringify(stored)).not.toContain('stale-client-secret');
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
function captureRegisteredMcpServerCreateHooks(db: TenantScopeAwareDatabase): {
  create: Array<(context: McpServerWriteHookContext) => Promise<unknown>>;
  patch: Array<(context: McpServerWriteHookContext) => Promise<unknown>>;
} {
  const captured = {
    create: [] as Array<(context: McpServerWriteHookContext) => Promise<unknown>>,
    patch: [] as Array<(context: McpServerWriteHookContext) => Promise<unknown>>,
  };
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: { create?: unknown[]; patch?: unknown[] } }) {
          if (path.replace(/^\//, '') !== 'mcp-servers') return;
          captured.create.push(
            ...((hooks.before?.create ?? []) as Array<
              (context: McpServerWriteHookContext) => Promise<unknown>
            >)
          );
          captured.patch.push(
            ...((hooks.before?.patch ?? []) as Array<
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
    const patchTarget = await new MCPServerRepository(rawDb).create({
      name: 'registered-hook-patch-target',
      transport: 'http',
      url: 'https://mcp.example.test',
      scope: 'global',
      owner_user_id: bob.user_id as UserID,
      source: 'user',
    });

    const registeredHooks = captureRegisteredMcpServerCreateHooks(db);
    const createAs = async (
      caller: User,
      data: Record<string, unknown>,
      presentedUserId = caller.user_id
    ) => {
      const context = {
        method: 'create',
        data: {
          name: 'registered-hook-test',
          transport: 'http',
          url: 'https://mcp.example.test',
          scope: 'global',
          enabled: true,
          ...data,
        },
        params: {
          provider: 'rest',
          user: { user_id: presentedUserId, role: 'member' },
        } as unknown as AuthenticatedParams,
      } satisfies McpServerWriteHookContext;
      for (const hook of registeredHooks.create) await hook(context);
      return context;
    };

    const patchAs = async (caller: User, data: Record<string, unknown>) => {
      const context = {
        method: 'patch',
        id: patchTarget.mcp_server_id,
        data,
        params: {
          provider: 'rest',
          user: { user_id: caller.user_id, role: 'member' },
        } as unknown as AuthenticatedParams,
      } satisfies McpServerWriteHookContext;
      for (const hook of registeredHooks.patch) await hook(context);
      return context;
    };

    return { bob, mallory, createAs, patchAs };
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

  it('canonicalizes private ownership and preserves an explicit shared create', async () => {
    const { bob, createAs } = await standUpDaemonHooks('allow_crud');
    const presented = shortId(bob.user_id);

    const privateContext = await createAs(bob, { transport: 'http' }, presented);
    const sharedContext = await createAs(
      bob,
      { transport: 'http', owner_user_id: null },
      presented
    );

    expect((privateContext.data as { owner_user_id?: string }).owner_user_id).toBe(bob.user_id);
    expect((sharedContext.data as { owner_user_id?: string | null }).owner_user_id).toBeNull();
  });

  it.each(['marketplace', 'future-mode'])(
    'rejects public create and patch compatibility mode %s at the authorized write boundary',
    async (mode) => {
      const { bob, createAs, patchAs } = await standUpDaemonHooks();
      const data = {
        transport: 'http',
        auth: { type: 'oauth', oauth_compatibility_mode: mode },
      };

      await expect(createAs(bob, data)).rejects.toThrow(/must be either strict or legacy/);
      await expect(patchAs(bob, data)).rejects.toThrow(/must be either strict or legacy/);
    }
  );
});

/**
 * Collect the read chain `registerHooks` actually leaves on `mcp-servers`.
 *
 * Credential reuse is decided by reading whether a token arrived on a row, and
 * the only thing that puts one there is `injectPerUserOAuthTokens` — which is
 * module-private, keys its lookup on the authenticated caller, and is followed
 * by redaction. Rebuilding an equivalent here would prove reuse is safe against
 * a copy of the rule rather than the rule, which is the exact mistake the
 * unowned-install bug was made of. So the production registration is captured
 * and mounted, the same way `captureRegisteredMcpServerCreateHooks` does for
 * the write path.
 */
function captureRegisteredMcpServerHooks(db: TenantScopeAwareDatabase) {
  const captured = {
    beforeAll: [] as unknown[],
    beforeFind: [] as unknown[],
    afterFind: [] as unknown[],
    afterGet: [] as unknown[],
  };
  const app = {
    service(path: string) {
      return {
        hooks(hooks: {
          before?: { all?: unknown[]; find?: unknown[] };
          after?: { find?: unknown[]; get?: unknown[] };
        }) {
          if (path.replace(/^\//, '') !== 'mcp-servers') return;
          captured.beforeAll.push(...(hooks.before?.all ?? []));
          captured.beforeFind.push(...(hooks.before?.find ?? []));
          captured.afterFind.push(...(hooks.after?.find ?? []));
          captured.afterGet.push(...(hooks.after?.get ?? []));
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
    jwtSecret: 'mcp-credential-reuse-test-secret',
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

/**
 * CONNECT-3 across two users, with real grants in a real database.
 *
 * The row both users can see is deliberately unowned: an owned one would be
 * filtered out of Bob's `find` by `usableByUserId` before reuse ever looked at
 * it, so passing that would prove only that the ownership filter works. This
 * puts the row squarely inside Bob's reach and asks whether Alice's *credential*
 * on it can be borrowed.
 */
describe('credential reuse, against real grants', () => {
  const OAUTH_ENTRY = {
    ...CURATED,
    auth_type: 'oauth',
    oauth: { compatibility_mode: 'strict' },
  } as unknown as MCPCatalogEntry;
  const SHARED_ROW = '00000000-0000-7000-8000-0000000005ee' as MCPServer['mcp_server_id'];
  const RESOURCE = 'https://mcp.deepwiki.com/mcp';

  /**
   * Two members, one unowned OAuth row both can see, and a real grant on it
   * belonging to exactly one of them.
   *
   * The row is deliberately unowned: an owned one would be filtered out of the
   * other user's `find` by `usableByUserId` before reuse ever looked at it, so
   * passing that would prove only that the ownership filter works. This puts
   * the row squarely inside both users' reach and asks whether one's
   * *credential* on it can be borrowed by the other.
   */
  async function buildTwoUserDaemon(grantResourceUri: string | undefined = RESOURCE) {
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = rawDb as unknown as TenantScopeAwareDatabase;
    await runMigrations(rawDb);
    await setMcpMemberPolicy(db, 'allow_private_only', undefined, null);

    const users = new UsersRepository(rawDb);
    const alice = (await users.create({
      email: 'alice@agor.live',
      name: 'Alice',
      role: 'member',
    })) as User;
    const bob = (await users.create({
      email: 'bob@agor.live',
      name: 'Bob',
      role: 'member',
    })) as User;

    await new MCPServerRepository(rawDb).create({
      mcp_server_id: SHARED_ROW,
      name: 'deepwiki-shared',
      transport: 'http',
      url: RESOURCE,
      auth: { type: 'oauth', oauth_mode: 'per_user', oauth_compatibility_mode: 'strict' },
      scope: 'session',
      source: 'user',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    } as never);

    // Alice signs in. Hers, keyed `(alice, row)`, and nothing else changes.
    // Intentionally omit `grantBinding` to model a legacy SQLite grant created
    // before versioned fingerprints were introduced.
    const tokens = new UserMCPOAuthTokenRepository(rawDb);
    await tokens.saveToken(alice.user_id, SHARED_ROW, {
      accessToken: 'alice-grant-not-a-real-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...(grantResourceUri ? { resourceUri: grantResourceUri } : {}),
    });

    const hooks = captureRegisteredMcpServerHooks(db);
    const app = feathers();
    app.use('mcp-servers', createMCPServersService(db));
    app.service('mcp-servers').hooks({
      before: {
        all: hooks.beforeAll,
        find: hooks.beforeFind,
        create: [createMcpServerWriteAuthorizationHook(db)],
      },
      after: { find: hooks.afterFind, get: hooks.afterGet },
    } as never);
    app.use('mcp-catalog', {
      async get() {
        return OAUTH_ENTRY;
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
    app.use('/mcp-servers/oauth-refresh', {
      async create() {
        return { success: false, error: 'needs_reauth' };
      },
    } as never);

    // The real read the daemon injects, against the real table — so "whose
    // grant" is decided by the same key the production wiring uses.
    const candidateRepo = new MCPCatalogCandidateRepository(rawDb);
    const deps = {
      resolveUserId: async (userId: string) => userId as UserID,
      listCandidates: (userId: User['user_id']) => candidateRepo.listForUser(userId),
      getCandidate: (userId: User['user_id'], serverId: MCPServer['mcp_server_id']) =>
        candidateRepo.getForUser(userId, serverId),
      async isGrantAuthorized(
        candidate: import('@agor/core/types').MCPCatalogServerCandidate,
        params: AuthenticatedParams
      ) {
        const userId = params.user?.user_id as User['user_id'] | undefined;
        if (!userId) return false;
        const grant = await tokens.getCatalogGrantAuthority(userId, candidate.server.mcp_server_id);
        return Boolean(
          grant?.has_access_token &&
            (await isMCPOAuthGrantAuthorizedForServer(db, candidate.server, grant))
        );
      },
    };

    const connectAs = (caller: User) =>
      createMCPCatalogConnectService(app, deps).create(CONNECT_REQUEST, {
        provider: 'rest',
        authenticated: true,
        user: { user_id: caller.user_id, role: 'member' },
      } as unknown as AuthenticatedParams);

    return { alice, bob, connectAs, rawDb };
  }

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('oauth');
  });

  it('reuses the grant for the user who holds it', async () => {
    // The positive control. Without it the negatives below would also pass if
    // reuse were simply broken, and would keep passing after it was removed.
    const { alice, connectAs } = await buildTwoUserDaemon();

    const result = await connectAs(alice);

    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe(SHARED_ROW);
    expect(result.mcp_server.auth?.oauth_access_token).toBeTruthy();
  });

  it('never lends Alice’s grant to Bob', async () => {
    const { bob, connectAs, rawDb } = await buildTwoUserDaemon();

    const result = await connectAs(bob);

    // Same fixtures, same row in reach, only the caller differs.
    expect(result.reused_existing_server).toBe(false);
    expect(result.mcp_server.mcp_server_id).not.toBe(SHARED_ROW);
    expect(result.mcp_server.auth?.oauth_access_token).toBeUndefined();

    // And nothing was minted, copied, or re-keyed on the way past.
    const tokens = new UserMCPOAuthTokenRepository(rawDb);
    expect(await tokens.getToken(bob.user_id, SHARED_ROW)).toBeNull();
    expect(await tokens.getToken(bob.user_id, result.mcp_server.mcp_server_id)).toBeNull();
  });

  it('does not leak the grant through the row it hands Bob back', async () => {
    // The other way a credential could travel: not as a reused row, but as a
    // token hydrated onto whatever connect returns.
    const { bob, connectAs } = await buildTwoUserDaemon();

    const result = await connectAs(bob);

    expect(JSON.stringify(result)).not.toContain('alice-grant-not-a-real-token');
  });

  /**
   * Legacy SQLite compatibility, pinned in both directions. Current SQLite
   * OAuth flows create versioned fingerprints; these fixtures deliberately
   * model historical unbound grants. Such a grant is stopped
   * instead by the resource the grant records, which every dialect writes
   * (second test). If someone makes the fingerprint check dialect-independent,
   * the first fails and should be deleted with the note above. If someone drops
   * the resource comparison, the second fails and standalone loses its only
   * check here.
   */
  it('reuses a legacy unbound SQLite grant when its protected resource still matches', async () => {
    const { alice, connectAs, rawDb } = await buildTwoUserDaemon();

    const grant = await new UserMCPOAuthTokenRepository(rawDb).getToken(alice.user_id, SHARED_ROW);
    expect(grant?.grant_binding_fingerprint).toBeUndefined();

    await expect(connectAs(alice)).resolves.toMatchObject({ reused_existing_server: true });
  });

  it('still refuses a SQLite grant minted for a different resource', async () => {
    // The row points at the entry's endpoint; the credential on it does not.
    const { alice, connectAs } = await buildTwoUserDaemon('https://mcp.deepwiki.com/some-other');

    const result = await connectAs(alice);

    expect(result.reused_existing_server).toBe(false);
    expect(result.mcp_server.mcp_server_id).not.toBe(SHARED_ROW);
  });
});
