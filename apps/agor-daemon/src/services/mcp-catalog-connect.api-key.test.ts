/**
 * Where a marketplace API key ends up, and who can read it back.
 *
 * `mcp-catalog-connect.test.ts` drives connect against stub services, which is
 * the right shape for asserting what it derives and what it refuses — but every
 * claim that matters here is a claim about machinery connect does not own. The
 * key is redacted by a hook registered in `register-hooks.ts`, on a service in
 * `mcp-servers.ts`, over a row in a database, and the property is that a user
 * cannot read it back. A stub `mcp-servers` would answer whatever the stub was
 * written to answer, which is precisely the wrong thing to ask.
 *
 * So this stands up the real service, the real database, and — importantly —
 * the hooks as `registerHooks` actually registers them, captured rather than
 * re-listed. A test that attaches its own idea of the hook chain keeps passing
 * when a line is deleted from `register-hooks.ts`; that is how the missing
 * `remove` redaction stayed invisible (#2374), and re-listing here would set up
 * the same blind spot for `auth.token`.
 *
 * Only the catalog, sessions, and the session attachment are stubbed: they
 * decide nothing about credentials, and a session needs a branch, a repo, and a
 * worktree that have no bearing on any of this.
 *
 * Every key here is an obvious fake. A fixture is a file in a public
 * repository — the same reason `curated.yaml` cannot hold one.
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
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPServer,
  User,
  UserRole,
} from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { createMCPCatalogConnectService } from './mcp-catalog-connect.js';
import { createMCPServersService } from './mcp-servers.js';

const { probeRemoteAuthType, probeRemoteApiKey } = vi.hoisted(() => ({
  probeRemoteAuthType: vi.fn(),
  probeRemoteApiKey: vi.fn(),
}));
vi.mock('@agor/core/mcp-catalog', () => ({ probeRemoteAuthType, probeRemoteApiKey }));

const DATADOG = 'com.datadoghq/mcp';
const DISCLOSURE = 'Reads metrics, logs, traces, monitors, and incidents.';

/** The one curated entry that states `credentials`, trimmed to what is used. */
const CURATED = {
  name: DATADOG,
  title: 'Datadog',
  transport: 'streamable-http',
  remote_url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
  has_remote: true,
  auth_type: 'credentials',
  permission_disclosure: DISCLOSURE,
} as unknown as MCPCatalogEntry;

const CONNECT_REQUEST = {
  catalog_key: DATADOG,
  branch_id: 'branch-1',
  agentic_tool: 'claude-code' as const,
  acknowledged_disclosure: DISCLOSURE,
};

type HookFn = (context: unknown) => Promise<unknown>;
type HookChains = Record<string, HookFn[]>;

/**
 * The `mcp-servers` hook chains exactly as `registerHooks` leaves them.
 *
 * The app is a stub that records what each service is registered with — the
 * approach `mcp-catalog-connect.install.test.ts` already uses for the write
 * hook — widened to collect `after` as well, because the redaction this file is
 * about lives there. `all` is folded into every method, the way Feathers does,
 * so nothing registered that way is quietly dropped.
 *
 * The database is real: several of these hooks read rows.
 */
function captureRegisteredMcpServerHooks(db: TenantScopeAwareDatabase): {
  before: HookChains;
  after: HookChains;
} {
  const before: HookChains = {};
  const after: HookChains = {};
  const METHODS = ['find', 'get', 'create', 'patch', 'update', 'remove'];

  const collect = (into: HookChains, registered: Record<string, HookFn[]> | undefined) => {
    if (!registered) return;
    for (const [method, hooks] of Object.entries(registered)) {
      const targets = method === 'all' ? METHODS : [method];
      for (const target of targets) {
        into[target] = [...(into[target] ?? []), ...hooks];
      }
    }
  };

  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: Record<string, HookFn[]>; after?: Record<string, HookFn[]> }) {
          if (path.replace(/^\//, '') !== 'mcp-servers') return;
          collect(before, hooks.before);
          collect(after, hooks.after);
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
    jwtSecret: 'mcp-api-key-test-secret',
    // The production `requireAuth` needs a full authentication service. Every
    // caller here is already authenticated by construction, and what is under
    // test is redaction rather than the auth gate.
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

  return { before, after };
}

async function buildDaemon(entry: MCPCatalogEntry = CURATED) {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  await runMigrations(rawDb);
  await setMcpMemberPolicy(db, 'allow_crud', undefined, null);

  const users = new UsersRepository(rawDb);
  const repo = new MCPServerRepository(rawDb);

  const app = feathers();
  app.use('mcp-servers', createMCPServersService(db));

  const registered = captureRegisteredMcpServerHooks(db);

  /**
   * What a socket client would actually be sent.
   *
   * @feathersjs/transport-commons dispatches `context.dispatch || context.result`,
   * so asserting on `result` alone cannot see a raw payload riding out on
   * `dispatch` — the shape the tenant-wide broadcast takes.
   */
  let lastContext: { dispatch?: unknown; result?: unknown } = {};
  const recordFinishedContext = async (context: { dispatch?: unknown; result?: unknown }) => {
    lastContext = context;
    return context;
  };

  app.service('mcp-servers').hooks({
    before: registered.before,
    after: Object.fromEntries(
      Object.entries(registered.after).map(([method, hooks]) => [
        method,
        [...hooks, recordFinishedContext],
      ])
    ),
  } as never);

  app.use('mcp-catalog', {
    async get() {
      return entry;
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

  const paramsFor = (caller: User, role: UserRole = 'member') =>
    ({
      provider: 'rest',
      authenticated: true,
      user: { user_id: caller.user_id, role },
    }) as unknown as AuthenticatedParams;

  return {
    addUser: (email: string, role: UserRole = 'member') =>
      users.create({ email, name: email, role }) as Promise<User>,
    paramsFor,
    connectAs: (caller: User, apiKey?: string) =>
      createMCPCatalogConnectService(app).create(
        { ...CONNECT_REQUEST, ...(apiKey === undefined ? {} : { api_key: apiKey }) },
        paramsFor(caller)
      ),
    find: (caller: User) =>
      app.service('mcp-servers').find(paramsFor(caller)) as Promise<{ data: MCPServer[] }>,
    get: (caller: User, id: string) =>
      app.service('mcp-servers').get(id, paramsFor(caller)) as Promise<MCPServer>,
    /** What the socket transport would put on the wire for the last call. */
    lastDispatched: () => (lastContext.dispatch ?? lastContext.result) as unknown,
    captureBroadcasts: (event: 'created' | 'patched') => {
      const sent: unknown[] = [];
      app
        .service('mcp-servers')
        .on(event, (_element: unknown, hook: { dispatch?: unknown; result?: unknown }) => {
          sent.push(hook.dispatch ?? hook.result);
        });
      return sent;
    },
    /** The row as it actually sits in the database, past every hook. */
    stored: () => repo.findAll({}),
  };
}

const WORKING_KEY = 'fake-datadog-key-aaaa';
const ROTATED_KEY = 'fake-datadog-key-bbbb';

describe('an API-key install, end to end', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('credentials');
    probeRemoteApiKey.mockReset();
    probeRemoteApiKey.mockResolvedValue('accepted');
  });

  it('produces a working server row carrying the key', async () => {
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');

    await daemon.connectAs(alice, WORKING_KEY);

    const [row] = await daemon.stored();
    // Stored raw, because the executor has to send it: `resolveMCPAuthHeaders`
    // turns `auth.token` into `Authorization: Bearer …`. Redaction is a
    // property of the read path, not of storage.
    expect(row).toMatchObject({
      transport: 'http',
      url: CURATED.remote_url,
      scope: 'session',
      source: 'catalog',
      catalog_entry_name: DATADOG,
      owner_user_id: alice.user_id,
      enabled: true,
      auth: { type: 'bearer', token: WORKING_KEY },
    });
  });

  it('does not hand the key back to the installer on the connect reply', async () => {
    // Including its owner. There is no screen that needs to show a key back,
    // and "only the owner" is a rule that has to be right in every reader.
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');

    const result = await daemon.connectAs(alice, WORKING_KEY);

    expect(result.mcp_server.auth?.token).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(WORKING_KEY);
  });

  it('redacts the key on every read path', async () => {
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    const { mcp_server } = await daemon.connectAs(alice, WORKING_KEY);

    const listed = await daemon.find(alice);
    const fetched = await daemon.get(alice, mcp_server.mcp_server_id);

    expect(listed.data[0]?.auth?.token).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(fetched.auth?.token).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(listed)).not.toContain(WORKING_KEY);
    expect(JSON.stringify(fetched)).not.toContain(WORKING_KEY);
  });

  it('keeps the key out of the created event broadcast to the whole tenant', async () => {
    // `mcp-servers` events go to the tenant-wide authenticated channel, so an
    // unredacted one hands the key to every connected member at once. The
    // assertion reads `dispatch ?? result` because that is the formula the
    // socket transport uses; asserting on the event argument alone would miss
    // a raw `dispatch` entirely.
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    const broadcast = daemon.captureBroadcasts('created');

    await daemon.connectAs(alice, WORKING_KEY);

    expect(broadcast).toHaveLength(1);
    expect(JSON.stringify(broadcast)).not.toContain(WORKING_KEY);
    expect((broadcast[0] as MCPServer).auth?.token).toBe(MCP_HEADER_REDACTED_SENTINEL);
  });

  it('keeps the key out of the patched event when a key is rotated', async () => {
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    await daemon.connectAs(alice, WORKING_KEY);
    const broadcast = daemon.captureBroadcasts('patched');

    await daemon.connectAs(alice, ROTATED_KEY);

    expect(broadcast).toHaveLength(1);
    expect(JSON.stringify(broadcast)).not.toContain(ROTATED_KEY);
    expect(JSON.stringify(broadcast)).not.toContain(WORKING_KEY);
  });

  it('rotates the stored key in place rather than piling up rows', async () => {
    // Rotation is the ordinary life of an API key, and reconnecting from the
    // marketplace is where a user would do it.
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');

    const first = await daemon.connectAs(alice, WORKING_KEY);
    const second = await daemon.connectAs(alice, ROTATED_KEY);

    expect(second.reused_existing_server).toBe(true);
    expect(second.mcp_server.mcp_server_id).toBe(first.mcp_server.mcp_server_id);
    const rows = await daemon.stored();
    expect(rows).toHaveLength(1);
    // The old key is gone, not shadowed by a second row nobody uses.
    expect(rows[0]?.auth?.token).toBe(ROTATED_KEY);
  });
});

describe('two colleagues connecting the same API-key entry', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('credentials');
    probeRemoteApiKey.mockReset();
    probeRemoteApiKey.mockResolvedValue('accepted');
  });

  const ALICE_KEY = 'fake-alice-key-1111';
  const BOB_KEY = 'fake-bob-key-2222';

  it('gives each of them their own row holding their own key', async () => {
    // The failure this prevents looks exactly like the feature working: reuse
    // exists to avoid a duplicate row, and the duplicate is what keeps two
    // people's credentials apart.
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    const bob = await daemon.addUser('bob@agor.live');

    const aliceResult = await daemon.connectAs(alice, ALICE_KEY);
    const bobResult = await daemon.connectAs(bob, BOB_KEY);

    expect(bobResult.reused_existing_server).toBe(false);
    expect(bobResult.mcp_server.mcp_server_id).not.toBe(aliceResult.mcp_server.mcp_server_id);

    const rows = await daemon.stored();
    expect(rows).toHaveLength(2);
    const byOwner = new Map(rows.map((row) => [row.owner_user_id, row.auth?.token]));
    expect(byOwner.get(alice.user_id)).toBe(ALICE_KEY);
    expect(byOwner.get(bob.user_id)).toBe(BOB_KEY);
  });

  it('does not show one of them the other’s row at all', async () => {
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    const bob = await daemon.addUser('bob@agor.live');
    const aliceResult = await daemon.connectAs(alice, ALICE_KEY);

    const bobsView = await daemon.find(bob);

    expect(bobsView.data).toHaveLength(0);
    expect(JSON.stringify(bobsView)).not.toContain(ALICE_KEY);
    await expect(daemon.get(bob, aliceResult.mcp_server.mcp_server_id)).rejects.toThrow(
      /not found/
    );
  });

  it('does not let one of them rotate the other’s key by reconnecting', async () => {
    // Reuse decides which row a connect writes to. If it ever matched across
    // users, this connect would overwrite Alice's credential with Bob's.
    const daemon = await buildDaemon();
    const alice = await daemon.addUser('alice@agor.live');
    const bob = await daemon.addUser('bob@agor.live');
    await daemon.connectAs(alice, ALICE_KEY);

    await daemon.connectAs(bob, BOB_KEY);

    const rows = await daemon.stored();
    const aliceRow = rows.find((row) => row.owner_user_id === alice.user_id);
    expect(aliceRow?.auth?.token).toBe(ALICE_KEY);
  });
});

describe('the paths an API key does not change', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteApiKey.mockReset();
  });

  it('installs an open endpoint with no auth, as before', async () => {
    probeRemoteAuthType.mockResolvedValue('none');
    const daemon = await buildDaemon({ ...CURATED, auth_type: 'none' });
    const alice = await daemon.addUser('alice@agor.live');

    await daemon.connectAs(alice);

    const [row] = await daemon.stored();
    expect(row?.auth).toEqual({ type: 'none' });
    expect(probeRemoteApiKey).not.toHaveBeenCalled();
  });

  it('installs an OAuth endpoint configured-but-unauthenticated, as before', async () => {
    probeRemoteAuthType.mockResolvedValue('oauth');
    const daemon = await buildDaemon({ ...CURATED, auth_type: 'oauth' });
    const alice = await daemon.addUser('alice@agor.live');

    await daemon.connectAs(alice);

    const [row] = await daemon.stored();
    expect(row?.auth).toEqual({ type: 'oauth', oauth_mode: 'per_user' });
    expect(probeRemoteApiKey).not.toHaveBeenCalled();
  });

  it('still lets two users share one unauthenticated install', async () => {
    // The ownership rule reuse gained is about what a row carries, not about
    // who installed it — so an open server is unaffected. A row here is owned
    // by its installer but reachable through the reuse search only when it
    // keeps no credential, which this one does not.
    probeRemoteAuthType.mockResolvedValue('none');
    const daemon = await buildDaemon({ ...CURATED, auth_type: 'none' });
    const alice = await daemon.addUser('alice@agor.live');

    const first = await daemon.connectAs(alice);
    const second = await daemon.connectAs(alice);

    expect(second.reused_existing_server).toBe(true);
    expect(second.mcp_server.mcp_server_id).toBe(first.mcp_server.mcp_server_id);
  });
});
