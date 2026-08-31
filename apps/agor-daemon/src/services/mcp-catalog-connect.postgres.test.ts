/**
 * PostgreSQL proof for the production catalog-connect registration boundary.
 * The repository PostgreSQL runner supplies an isolated database and a
 * non-superuser/NOBYPASSRLS role.
 */
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  setMcpMemberPolicy,
  sql,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPCatalogEntry, MCPServer, User } from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { createRegisteredMCPCatalogConnectService } from '../register-routes.js';
import { fingerprintMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding.js';
import { createMCPServersService } from './mcp-servers.js';

const { probeRemoteAuthType, probeRemoteBearerToken } = vi.hoisted(() => ({
  probeRemoteAuthType: vi.fn(),
  probeRemoteBearerToken: vi.fn(),
}));
vi.mock('@agor/core/mcp-catalog', () => ({
  loadCatalog: vi.fn().mockResolvedValue([]),
  probeRemoteAuthType,
  probeRemoteBearerToken,
}));

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const SECRET = 'catalog-connect-postgres-integration-secret';
const RESOURCE = 'https://mcp.example.test/connect';
const ENTRY = {
  name: 'test/catalog-connect-postgres',
  title: 'PostgreSQL Connect Test',
  transport: 'streamable-http',
  remote_url: RESOURCE,
  has_remote: true,
  has_package: false,
  // Deliberately stale: the probe is authoritative and returns OAuth.
  auth_type: 'none',
  oauth: { compatibility_mode: 'strict' },
  permission_disclosure: 'Exercises the PostgreSQL catalog connect boundary.',
} as unknown as MCPCatalogEntry;
const REQUEST = {
  catalog_key: ENTRY.name,
  branch_id: 'branch-postgres-test',
  agentic_tool: 'claude-code' as const,
  acknowledged_disclosure: ENTRY.permission_disclosure,
};
const CREDENTIAL_ENTRY = {
  ...ENTRY,
  name: 'test/catalog-connect-postgres-credentials',
  auth_type: 'credentials',
  credentials: { scheme: 'bearer' },
} as unknown as MCPCatalogEntry;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function registeredMcpServerHooks(db: TenantScopeAwareDatabase) {
  const captured = {
    aroundAll: [] as unknown[],
    beforeAll: [] as unknown[],
    beforeFind: [] as unknown[],
    beforeCreate: [] as unknown[],
    afterFind: [] as unknown[],
    afterGet: [] as unknown[],
  };
  const app = {
    service(path: string) {
      return {
        hooks(hooks: {
          around?: { all?: unknown[] };
          before?: { all?: unknown[]; find?: unknown[]; create?: unknown[] };
          after?: { find?: unknown[]; get?: unknown[] };
        }) {
          if (path.replace(/^\//, '') !== 'mcp-servers') return;
          captured.aroundAll.push(...(hooks.around?.all ?? []));
          captured.beforeAll.push(...(hooks.before?.all ?? []));
          captured.beforeFind.push(...(hooks.before?.find ?? []));
          captured.beforeCreate.push(...(hooks.before?.create ?? []));
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
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
    } as RegisterHooksContext['config'],
    jwtSecret: SECRET,
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    deployment: { mode: 'hosted' } as RegisterHooksContext['deployment'],
  });
  return captured;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'registered catalog connect (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;
    let previousMasterSecret: string | undefined;

    beforeAll(async () => {
      previousMasterSecret = process.env.AGOR_MASTER_SECRET;
      process.env.AGOR_MASTER_SECRET = SECRET;
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'catalog-connect-postgres-test',
      });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
    });

    beforeEach(() => {
      probeRemoteAuthType.mockReset();
      probeRemoteAuthType.mockResolvedValue('oauth');
      probeRemoteBearerToken.mockReset();
      probeRemoteBearerToken.mockResolvedValue('accepted');
    });

    async function buildTenant(label: string) {
      const tenantId = `catalog-connect-${label}-${generateId()}`;
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await setMcpMemberPolicy(scoped, 'allow_crud', tenantId, null);
        const user = await buildUser(scoped, label);
        return { tenantId, user };
      });
    }

    async function buildUser(scoped: Database, label: string) {
      return (await new UsersRepository(scoped).create({
        email: `${label}-${generateId()}@example.test`,
        name: label,
        role: 'member',
      })) as User;
    }

    async function seedPeer(
      tenantId: string,
      user: User,
      options: { fingerprintDrift?: boolean; compatibilityMode?: 'strict' | 'legacy' } = {}
    ) {
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const server = await new MCPServerRepository(scoped).create({
          name: `peer-${generateId()}`,
          transport: 'http',
          url: RESOURCE,
          scope: 'session',
          source: 'user',
          enabled: true,
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_compatibility_mode: options.compatibilityMode ?? 'strict',
          },
        });
        const resolved = {
          resourceUri: RESOURCE,
          metadataUrl: `${RESOURCE}/.well-known/oauth-protected-resource`,
          issuer: 'https://identity.example.test',
          authorizationEndpoint: 'https://identity.example.test/authorize',
          tokenEndpoint: 'https://identity.example.test/token',
          redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
          clientId: 'catalog-connect-client',
          compatibilityMode: options.compatibilityMode ?? 'strict',
        } as const;
        const fingerprintServer = options.fingerprintDrift
          ? ({ ...server, url: `${RESOURCE}/old` } as MCPServer)
          : server;
        await new UserMCPOAuthTokenRepository(scoped, SECRET).saveToken(
          user.user_id,
          server.mcp_server_id,
          {
            accessToken: `access-${tenantId}-${generateId()}`,
            clientId: resolved.clientId,
            expiresAt: new Date(Date.now() + 3_600_000),
            grantBinding: {
              generation: 1,
              version: 1,
              fingerprint: fingerprintMCPOAuthGrantConfiguration(
                SECRET,
                fingerprintServer,
                resolved,
                1
              ),
              ...resolved,
              metadataUri: resolved.metadataUrl,
            },
          }
        );
        return server;
      });
    }

    function connectApp(entry: MCPCatalogEntry = ENTRY) {
      const hooks = registeredMcpServerHooks(db);
      const app = feathers();
      app.use('mcp-servers', createMCPServersService(db));
      app.service('mcp-servers').hooks({
        around: { all: hooks.aroundAll },
        before: {
          all: hooks.beforeAll,
          find: hooks.beforeFind,
          create: hooks.beforeCreate,
        },
        after: { find: hooks.afterFind, get: hooks.afterGet },
      } as never);
      app.use('mcp-catalog', {
        async get() {
          return entry;
        },
      } as never);
      app.use('sessions', {
        async create(data: Record<string, unknown>) {
          return { ...data, session_id: `session-${generateId()}` };
        },
        async remove() {},
      } as never);
      app.use('/sessions/:id/mcp-servers', {
        async create(data: unknown) {
          return data;
        },
      } as never);
      app.use('/mcp-servers/oauth-refresh', {
        async create() {
          return { success: false };
        },
      } as never);
      return app;
    }

    function params(user: User, tenantId: string): AuthenticatedParams {
      return {
        provider: 'rest',
        authenticated: true,
        user: { user_id: user.user_id, email: user.email, role: 'member' },
        authentication: { strategy: 'jwt', payload: { tenant_id: tenantId } },
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
      } as AuthenticatedParams;
    }

    async function connect(
      user: User,
      tenantId: string,
      entry: MCPCatalogEntry = ENTRY,
      app = connectApp(entry)
    ) {
      // Deliberately no ambient database scope here. This is the production
      // long-route shape: authenticated tenant identity is present, while each
      // database phase must open its own short scope on the required-scope
      // proxy. Wrapping this whole call would hide the regression this test
      // guards and would hold a PostgreSQL transaction across the remote probe.
      return createRegisteredMCPCatalogConnectService(app, db).create(
        REQUEST,
        params(user, tenantId)
      );
    }

    async function connectWithToken(
      user: User,
      tenantId: string,
      token: string,
      app = connectApp(CREDENTIAL_ENTRY)
    ) {
      return createRegisteredMCPCatalogConnectService(app, db).create(
        {
          ...REQUEST,
          catalog_key: CREDENTIAL_ENTRY.name,
          bearer_token: token,
        },
        params(user, tenantId)
      );
    }

    it('reuses the authenticated caller credential peer and obeys probed OAuth policy', async () => {
      const actor = await buildTenant('positive');
      const peer = await seedPeer(actor.tenantId, actor.user);
      const result = await connect(actor.user, actor.tenantId);

      expect(probeRemoteAuthType).toHaveBeenCalledWith(RESOURCE);
      expect(result).toMatchObject({
        reused_existing_server: true,
        reuse_kind: 'credential_peer',
        mcp_server: { mcp_server_id: peer.mcp_server_id },
      });
    });

    it('does not reuse or re-key a visible same-tenant peer grant for another user', async () => {
      const actor = await buildTenant('same-tenant-user-a');
      const otherUser = await runWithTenantDatabaseScope(db, actor.tenantId, (scoped) =>
        buildUser(scoped, 'same-tenant-user-b')
      );
      const peer = await seedPeer(actor.tenantId, actor.user);
      const app = connectApp();

      const visibleToOther = await runWithTenantDatabaseScope(db, actor.tenantId, () =>
        app.service('mcp-servers').find({
          ...params(otherUser, actor.tenantId),
          provider: undefined,
          query: { usableByUserId: otherUser.user_id, $limit: 1000 },
        })
      );
      expect(Array.isArray(visibleToOther) ? visibleToOther : visibleToOther.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ mcp_server_id: peer.mcp_server_id })])
      );

      // Both calls use the same tenant scope, so tenant RLS cannot distinguish
      // these users. The production grant lookup must enforce the user key.
      const actorResult = await connect(actor.user, actor.tenantId, ENTRY, app);
      expect(actorResult).toMatchObject({
        reused_existing_server: true,
        reuse_kind: 'credential_peer',
        mcp_server: { mcp_server_id: peer.mcp_server_id },
      });

      const otherResult = await connect(otherUser, actor.tenantId, ENTRY, app);
      expect(otherResult.reused_existing_server).toBe(false);
      expect(otherResult.mcp_server.mcp_server_id).not.toBe(peer.mcp_server_id);

      await runWithTenantDatabaseScope(db, actor.tenantId, async (scoped) => {
        const grants = new UserMCPOAuthTokenRepository(scoped, SECRET);
        expect(await grants.listForUser(actor.user.user_id)).toEqual([
          expect.objectContaining({
            user_id: actor.user.user_id,
            mcp_server_id: peer.mcp_server_id,
          }),
        ]);
        expect(await grants.listForUser(otherUser.user_id)).toEqual([]);
      });
    });

    it('denies cross-tenant reuse even with a valid foreign user and server identifier', async () => {
      const foreign = await buildTenant('foreign');
      const local = await buildTenant('local');
      const foreignPeer = await seedPeer(foreign.tenantId, foreign.user);

      const result = await connect(foreign.user, local.tenantId);
      expect(result.reused_existing_server).toBe(false);
      expect(result.mcp_server.mcp_server_id).not.toBe(foreignPeer.mcp_server_id);
    });

    it('rejects a grant whose durable binding drifted through the full connect path', async () => {
      const actor = await buildTenant('binding-drift');
      const peer = await seedPeer(actor.tenantId, actor.user, { fingerprintDrift: true });

      const result = await connect(actor.user, actor.tenantId);
      expect(result.reused_existing_server).toBe(false);
      expect(result.mcp_server.mcp_server_id).not.toBe(peer.mcp_server_id);
    });

    it('rejects catalog compatibility-policy drift through the full connect path', async () => {
      const actor = await buildTenant('policy-drift');
      const peer = await seedPeer(actor.tenantId, actor.user, { compatibilityMode: 'legacy' });

      const result = await connect(actor.user, actor.tenantId);
      expect(result.reused_existing_server).toBe(false);
      expect(result.mcp_server.mcp_server_id).not.toBe(peer.mcp_server_id);
      expect(result.mcp_server.auth?.oauth_compatibility_mode).toBe('strict');
    });

    it('keeps the newer bearer credential when an older PostgreSQL rotation resumes', async () => {
      probeRemoteAuthType.mockResolvedValue('credentials');
      const actor = await buildTenant('bearer-rotation-race');
      const app = connectApp(CREDENTIAL_ENTRY);
      await connectWithToken(actor.user, actor.tenantId, 'postgres-seed-key', app);
      const OLD_KEY = 'postgres-delayed-old-key';
      const NEW_KEY = 'postgres-new-key';
      let releaseOld!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let reached!: () => void;
      const atProbe = new Promise<void>((resolve) => {
        reached = resolve;
      });
      probeRemoteBearerToken.mockImplementation(async (_url, token) => {
        if (token === OLD_KEY) {
          reached();
          await blocked;
        }
        return 'accepted';
      });

      const older = connectWithToken(actor.user, actor.tenantId, OLD_KEY, app);
      await atProbe;
      const newerPending = connectWithToken(actor.user, actor.tenantId, NEW_KEY, app);
      await Promise.resolve();
      expect(probeRemoteBearerToken).not.toHaveBeenCalledWith(RESOURCE, NEW_KEY);
      releaseOld();
      await older;
      const newer = await newerPending;
      expect(newer.reused_existing_server).toBe(true);
      await runWithTenantDatabaseScope(db, actor.tenantId, async (scoped) => {
        const rows = await new MCPServerRepository(scoped).findAll({
          catalogEntryName: CREDENTIAL_ENTRY.name,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.auth?.token).toBe(NEW_KEY);
      });
    });

    it('fences a delayed PostgreSQL first connect after newer adoption and preserves the newer key', async () => {
      probeRemoteAuthType.mockResolvedValue('credentials');
      const actor = await buildTenant('bearer-first-race');
      const app = connectApp(CREDENTIAL_ENTRY);
      const OLD_KEY = 'postgres-delayed-first-key';
      const NEW_KEY = 'postgres-first-winner-key';
      let releaseOld!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let reached!: () => void;
      const atProbe = new Promise<void>((resolve) => {
        reached = resolve;
      });
      probeRemoteBearerToken.mockImplementation(async (_url, token) => {
        if (token === OLD_KEY) {
          reached();
          await blocked;
        }
        return 'accepted';
      });

      const older = connectWithToken(actor.user, actor.tenantId, OLD_KEY, app);
      await atProbe;
      const newer = await connectWithToken(actor.user, actor.tenantId, NEW_KEY, app);
      expect(newer.reused_existing_server).toBe(false);
      releaseOld();
      await expect(older).rejects.toThrow(/newer marketplace connect superseded/i);
      await runWithTenantDatabaseScope(db, actor.tenantId, async (scoped) => {
        const rows = await new MCPServerRepository(scoped).findAll({
          catalogEntryName: CREDENTIAL_ENTRY.name,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.auth?.token).toBe(NEW_KEY);
      });
    });
  }
);
