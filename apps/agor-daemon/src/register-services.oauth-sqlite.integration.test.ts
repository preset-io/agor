import http from 'node:http';
import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import { loadCatalog } from '@agor/core/mcp-catalog';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPServer,
  MCPServerID,
  User,
  UserID,
} from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegisteredMCPCatalogConnectService } from './register-routes.js';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';

// The boundary under test is daemon discovery/OAuth authority, not the MCP
// SDK's stream parser. Mock only the post-grant capability client so Vitest
// does not try to type-strip eventsource-parser's published TypeScript file.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() {
      return { tools: [] };
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
vi.mock('@agor/core/mcp-catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agor/core/mcp-catalog')>();
  return {
    ...original,
    loadCatalog: vi.fn((...args: Parameters<typeof original.loadCatalog>) =>
      original.loadCatalog(...args)
    ),
    probeRemoteAuthType: vi.fn().mockResolvedValue('oauth'),
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function durableAuthorityWithCreate(
  create: NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>['create']
): NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']> {
  return {
    create,
    maintain: vi.fn(),
  } as unknown as NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>;
}

type TestProvider = {
  baseUrl: string;
  savedMcpUrl: string;
  transientMcpUrl: string;
  requests: Array<{
    path: string;
    authorization?: string;
    transientHeader?: string;
    jsonBody?: Record<string, unknown>;
  }>;
  tokenRequested: Deferred<void>;
  refreshRequested: Deferred<void>;
  mcpRequested: Deferred<void>;
  releaseToken: () => void;
  releaseTokenRequest: (requestNumber: number) => void;
  waitForTokenRequest: (requestNumber: number) => Promise<void>;
  releaseRefresh: () => void;
  releaseMcp: () => void;
  close: () => Promise<void>;
};

async function createTestProvider(
  options: {
    holdToken?: boolean;
    holdTokenRequests?: number[];
    numberedTokenResponses?: boolean;
    holdRefresh?: boolean;
    invalidRefresh?: boolean;
    rejectDynamicRegistration?: boolean;
    resourceScopes?: string[];
    holdMcpChallenge?: boolean;
  } = {}
): Promise<TestProvider> {
  const requests: TestProvider['requests'] = [];
  const tokenRequestMilestones = new Map<number, Deferred<void>>();
  const tokenReleaseGates = new Map<number, Deferred<void>>();
  const tokenRequestMilestone = (requestNumber: number): Deferred<void> => {
    const existing = tokenRequestMilestones.get(requestNumber);
    if (existing) return existing;
    const created = deferred<void>();
    tokenRequestMilestones.set(requestNumber, created);
    return created;
  };
  const tokenReleaseGate = (requestNumber: number): Deferred<void> => {
    const existing = tokenReleaseGates.get(requestNumber);
    if (existing) return existing;
    const created = deferred<void>();
    tokenReleaseGates.set(requestNumber, created);
    return created;
  };
  const tokenRequested = tokenRequestMilestone(1);
  const refreshRequested = deferred<void>();
  const releaseRefresh = deferred<void>();
  const mcpRequested = deferred<void>();
  const releaseMcp = deferred<void>();
  let tokenRequestCount = 0;
  let baseUrl = '';

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const recordedRequest: TestProvider['requests'][number] = {
      path: url.pathname,
      authorization: request.headers.authorization,
      transientHeader:
        typeof request.headers['x-transient-config'] === 'string'
          ? request.headers['x-transient-config']
          : undefined,
    };
    requests.push(recordedRequest);

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          resource: `${baseUrl}/saved/mcp`,
          authorization_servers: [baseUrl],
          ...(options.resourceScopes ? { scopes_supported: options.resourceScopes } : {}),
        })
      );
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          ...(options.rejectDynamicRegistration
            ? { registration_endpoint: `${baseUrl}/register` }
            : {}),
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          // The DCR fixture deliberately omits RFC 9207 response-issuer
          // support. Reaching /register therefore proves that the canonical
          // catalog row selected Marketplace policy rather than strict.
          ...(options.rejectDynamicRegistration
            ? {}
            : { authorization_response_iss_parameter_supported: true }),
        })
      );
      return;
    }
    if (url.pathname === '/register' && options.rejectDynamicRegistration) {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      recordedRequest.jsonBody = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      // The DCR POST has crossed the provider boundary here. This controlled
      // fixture records it, then returns 418 without allocating a client or
      // grant; it is not an Agor-side pre-provider-mutation abort seam.
      response.writeHead(418, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture_rejected_registration' }));
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const isRefresh = new URLSearchParams(body).get('grant_type') === 'refresh_token';
      if (isRefresh) {
        refreshRequested.resolve();
        if (options.holdRefresh) await releaseRefresh.promise;
        response.writeHead(options.invalidRefresh ? 400 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(
            options.invalidRefresh
              ? { error: 'invalid_grant' }
              : {
                  access_token: 'stale-refreshed-access-token',
                  refresh_token: 'stale-rotated-refresh-token',
                  expires_in: 3600,
                }
          )
        );
        return;
      }
      tokenRequestCount += 1;
      const requestRelease = tokenReleaseGate(tokenRequestCount);
      tokenRequestMilestone(tokenRequestCount).resolve();
      if (options.holdToken || options.holdTokenRequests?.includes(tokenRequestCount)) {
        await requestRelease.promise;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: options.numberedTokenResponses
            ? `sqlite-access-token-${tokenRequestCount}`
            : 'sqlite-access-token',
          refresh_token: options.numberedTokenResponses
            ? `refresh-${tokenRequestCount}`
            : 'refresh',
          expires_in: 3600,
        })
      );
      return;
    }
    if (url.pathname === '/saved/mcp') {
      mcpRequested.resolve();
      if (options.holdMcpChallenge) await releaseMcp.promise;
      if (request.headers.authorization !== 'Bearer sqlite-access-token') {
        response.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
        response.end();
        return;
      }

      let body = '';
      for await (const chunk of request) body += String(chunk);
      const rpc = body ? (JSON.parse(body) as { id?: unknown; method?: string }) : {};
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'sqlite-oauth-test', version: '1.0.0' },
            }
          : rpc.method === 'tools/list'
            ? { tools: [] }
            : rpc.method === 'resources/list'
              ? { resources: [] }
              : rpc.method === 'prompts/list'
                ? { prompts: [] }
                : {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result }));
      return;
    }
    if (url.pathname === '/transient/mcp') {
      response.writeHead(418);
      response.end('transient configuration must not be contacted');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    savedMcpUrl: `${baseUrl}/saved/mcp`,
    transientMcpUrl: `${baseUrl}/transient/mcp`,
    requests,
    tokenRequested,
    refreshRequested,
    mcpRequested,
    releaseToken: () => {
      for (const gate of tokenReleaseGates.values()) gate.resolve();
    },
    releaseTokenRequest: (requestNumber: number) => tokenReleaseGate(requestNumber).resolve(),
    waitForTokenRequest: (requestNumber: number) => tokenRequestMilestone(requestNumber).promise,
    releaseRefresh: () => releaseRefresh.resolve(),
    releaseMcp: () => releaseMcp.resolve(),
    close: () => {
      for (const gate of tokenReleaseGates.values()) gate.resolve();
      releaseRefresh.resolve();
      releaseMcp.resolve();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

type SQLiteHarness = {
  app: Application & { io: unknown };
  db: TenantScopeAwareDatabase;
  rawDb: Awaited<ReturnType<typeof createDatabaseAsync>>;
  user: User;
  server: MCPServer;
  emittedBrowserEvents: Array<Record<string, unknown>>;
  nextAuthorizationUrl: () => Promise<string>;
  callback: (state: string) => Promise<{ status: number; body: string }>;
  deny: (state: string) => Promise<{ status: number; body: string }>;
  liveSocket: {
    id: string;
    feathers: AuthenticatedParams & { id: string };
    data: { tenant: { tenant_id: string; source: string } };
  };
};

async function createHarness(
  provider: TestProvider,
  oauthMode?: 'per_user' | 'shared',
  options: {
    catalogPeer?: boolean;
    catalogEntry?: MCPCatalogEntry;
    durableAuthority?: NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>;
    lockGrantConfiguration?: NonNullable<RegisterServicesContext['lockMcpOAuthGrantConfiguration']>;
  } = {}
) {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  const user = await new UsersRepository(rawDb).create({
    email: `sqlite-oauth-${Math.random()}@example.com`,
    role: 'admin',
  });
  const catalogEntry = options.catalogEntry;
  const server = await new MCPServerRepository(rawDb).create({
    name: 'sqlite-oauth-authority',
    transport: 'http',
    url: provider.savedMcpUrl,
    headers: options.catalogPeer || catalogEntry ? undefined : { 'X-Saved-Config': 'true' },
    scope: 'global',
    owner_user_id: user.user_id as UserID,
    ...(catalogEntry ? { source: 'catalog' as const, catalog_entry_name: catalogEntry.name } : {}),
    auth: {
      type: 'oauth',
      ...(catalogEntry ? {} : { oauth_client_id: 'saved-client-id' }),
      ...(options.catalogPeer ? { oauth_compatibility_mode: 'strict' as const } : {}),
      ...(catalogEntry || oauthMode ? { oauth_mode: oauthMode ?? 'per_user' } : {}),
    },
  });

  let nextUrl = deferred<string>();
  const emittedBrowserEvents: Array<Record<string, unknown>> = [];
  const liveSocket = {
    id: 'sqlite-test-socket',
    feathers: {
      id: 'sqlite-test-socket',
      user,
      authentication: {
        strategy: 'jwt',
        accessToken: 'sqlite-initial-authority-token',
      },
    } as AuthenticatedParams & { id: string },
    data: { tenant: { tenant_id: 'default', source: 'static' } },
  };
  const io = {
    local: {
      to: () => ({
        emit: (event: string, value: Record<string, unknown>) => {
          if (event === 'oauth:open_browser' && typeof value.authUrl === 'string') {
            emittedBrowserEvents.push(value);
            nextUrl.resolve(value.authUrl);
          }
        },
      }),
    },
    to: () => ({ emit: vi.fn() }),
    sockets: { sockets: new Map([[liveSocket.id, liveSocket]]) },
  };
  const app = feathers() as Application & { io: typeof io };
  app.io = io;
  const { oauthCallbackHandler } = await registerMCPServices({
    db,
    app,
    config: {} as RegisterServicesContext['config'],
    jwtSecret: 'test-jwt',
    daemonUrl: 'http://127.0.0.1:3030',
    bundledUiAvailable: false,
    DAEMON_PORT: 3030,
    UI_PORT: 5173,
    branchRbacEnabled: false,
    allowSuperadmin: false,
    requireAuth: async (context) => context,
    deployment: {} as RegisterServicesContext['deployment'],
    mcpOAuthPendingFlowAuthority: options.durableAuthority,
    lockMcpOAuthGrantConfiguration: options.lockGrantConfiguration,
  });

  const invokeCallback = async (
    query: Record<string, string>
  ): Promise<{ status: number; body: string }> => {
    let status = 200;
    let body = '';
    const response = {
      setHeader: vi.fn(),
      status(code: number) {
        status = code;
        return this;
      },
      send(value: string) {
        body = value;
        return this;
      },
    };
    await (oauthCallbackHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { query },
      response
    );
    return { status, body };
  };

  return {
    app,
    db,
    rawDb,
    user,
    server,
    emittedBrowserEvents,
    nextAuthorizationUrl: async () => {
      const value = await nextUrl.promise;
      nextUrl = deferred<string>();
      return value;
    },
    callback: (state: string) =>
      invokeCallback({ code: 'authorization-code', state, iss: provider.baseUrl }),
    deny: (state: string) => invokeCallback({ error: 'access_denied', state }),
    liveSocket,
  } satisfies SQLiteHarness;
}

function paramsFor(harness: SQLiteHarness): AuthenticatedParams & { connection: { id: string } } {
  return {
    user: harness.liveSocket.feathers.user,
    tenant: { tenant_id: 'default', source: 'static' },
    connection: harness.liveSocket.feathers,
    authentication: harness.liveSocket.feathers.authentication,
  } as AuthenticatedParams & { connection: { id: string } };
}

function addLiveAuthority(
  harness: SQLiteHarness,
  tenantId: string,
  userId: string,
  socketId: string
): AuthenticatedParams & { connection: { id: string } } {
  const user = {
    ...harness.user,
    user_id: userId as UserID,
    email: `${userId}@example.test`,
    role: 'member' as const,
  };
  const connection = {
    id: socketId,
    user,
    authentication: {
      strategy: 'jwt',
      accessToken: `token:${tenantId}:${userId}:${socketId}`,
    },
  } as AuthenticatedParams & { id: string };
  const socket = {
    id: socketId,
    feathers: connection,
    data: { tenant: { tenant_id: tenantId, source: 'auth' } },
  };
  (
    harness.app.io as {
      sockets: { sockets: Map<string, unknown> };
    }
  ).sockets.sockets.set(socketId, socket);
  return {
    user,
    tenant: { tenant_id: tenantId, source: 'auth' },
    connection,
    authentication: connection.authentication,
  } as AuthenticatedParams & { connection: { id: string } };
}

async function reserveBrowserEvent(
  harness: SQLiteHarness,
  operation: 'discover' | 'test-oauth'
): Promise<{ reservation_token: string }> {
  const reservation = (await harness.app
    .service('mcp-servers/oauth-browser-reservations')
    .create({ operation, mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
    reservation_token: string;
  };
  return { reservation_token: reservation.reservation_token };
}

async function authorizeSavedServer(harness: SQLiteHarness): Promise<void> {
  const started = (await harness.app
    .service('mcp-servers/oauth-start')
    .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
    success: boolean;
    authorizationUrl: string;
  };
  expect(started.success).toBe(true);
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  expect(state).toBeTruthy();
  expect((await harness.callback(state!)).status).toBe(200);
}

async function replaceWithNewAuthorization(harness: SQLiteHarness): Promise<number> {
  const repository = new UserMCPOAuthTokenRepository(harness.rawDb);
  const previous = await repository.getToken(
    harness.user.user_id as UserID,
    harness.server.mcp_server_id as MCPServerID
  );
  if (
    !previous?.grant_binding_fingerprint ||
    !previous.oauth_metadata_uri ||
    !previous.oauth_resource_uri ||
    !previous.oauth_issuer ||
    !previous.oauth_authorization_endpoint ||
    !previous.oauth_token_endpoint ||
    !previous.oauth_redirect_uri ||
    !previous.oauth_client_id
  ) {
    throw new Error('Expected a complete bound SQLite grant fixture');
  }
  const generation = previous.grant_generation + 1;
  await repository.saveToken(
    harness.user.user_id as UserID,
    harness.server.mcp_server_id as MCPServerID,
    {
      accessToken: 'new-authorization-access-token',
      refreshToken: 'new-authorization-refresh-token',
      clientId: previous.oauth_client_id,
      clientSecret: previous.oauth_client_secret,
      expiresAt: new Date(Date.now() + 3_600_000),
      grantBinding: {
        generation,
        version: 4,
        fingerprint: previous.grant_binding_fingerprint,
        metadataUri: previous.oauth_metadata_uri,
        resourceUri: previous.oauth_resource_uri,
        issuer: previous.oauth_issuer,
        authorizationEndpoint: previous.oauth_authorization_endpoint,
        tokenEndpoint: previous.oauth_token_endpoint,
        redirectUri: previous.oauth_redirect_uri,
      },
    }
  );
  return generation;
}

const providers: TestProvider[] = [];
const databases: SQLiteHarness['rawDb'][] = [];
let previousBaseUrl: string | undefined;
let previousMasterSecret: string | undefined;

beforeEach(() => {
  previousBaseUrl = process.env.AGOR_BASE_URL;
  previousMasterSecret = process.env.AGOR_MASTER_SECRET;
  process.env.AGOR_BASE_URL = 'https://agor.example.test';
  process.env.AGOR_MASTER_SECRET = 'a'.repeat(64);
});

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const db of databases.splice(0)) {
    (db as unknown as { $client?: { close(): void } }).$client?.close();
  }
  if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
  else process.env.AGOR_BASE_URL = previousBaseUrl;
  if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
  else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
});

describe('SQLite saved-row OAuth authority', () => {
  it('derives Marketplace policy and all advertised scopes at the service DCR boundary', async () => {
    const advertisedScopes = ['configure', 'read', 'read:sensitive', 'write', 'write:live'];
    const provider = await createTestProvider({
      rejectDynamicRegistration: true,
      resourceScopes: advertisedScopes,
    });
    providers.push(provider);
    const catalogEntry = {
      name: 'test/service-boundary-dcr-fixture',
      title: 'Service boundary DCR fixture',
      category: 'messaging',
      capabilities: ['automations'],
      benefit: 'Exercises the saved catalog policy boundary.',
      starter_prompt: 'Exercise the boundary.',
      permission_disclosure: 'Fixture only.',
      popularity_rank: 999_999,
      transport: 'streamable-http',
      remote_url: provider.savedMcpUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
    } as MCPCatalogEntry;
    // oauth-start and the two-phase helper each reload the current catalog
    // independently. Both must derive authority from the same canonical row.
    vi.mocked(loadCatalog)
      .mockResolvedValueOnce([catalogEntry])
      .mockResolvedValueOnce([catalogEntry]);
    const policyLog = vi.spyOn(console, 'info').mockImplementation(() => {});

    const harness = await createHarness(provider, undefined, { catalogEntry });
    databases.push(harness.rawDb);
    try {
      const result = (await harness.app.service('mcp-servers/oauth-start').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          // A request-supplied client cannot bypass DCR for a saved row.
          client_id: 'request-placeholder-must-be-ignored',
        },
        paramsFor(harness)
      )) as {
        success: boolean;
        authorizationUrl?: string;
        attempt_id?: string;
        redirect_uri?: string;
        diagnostic?: { stage?: string; http_status?: number };
      };

      expect(result).toMatchObject({
        success: false,
        redirect_uri: 'https://agor.example.test/mcp-servers/oauth-callback',
        diagnostic: { stage: 'dcr_registration', http_status: 418 },
      });
      expect(result.authorizationUrl).toBeUndefined();
      expect(result.attempt_id).toBeUndefined();
      expect(policyLog).toHaveBeenCalledWith(
        expect.stringContaining('mode=marketplace reason=current_catalog_marketplace')
      );

      const registrationRequests = provider.requests.filter(
        (request) => request.path === '/register'
      );
      expect(registrationRequests).toHaveLength(1);
      expect(registrationRequests[0]?.jsonBody).toMatchObject({
        redirect_uris: ['https://agor.example.test/mcp-servers/oauth-callback'],
        scope: advertisedScopes.join(' '),
        token_endpoint_auth_method: 'none',
      });
      expect(provider.requests.some((request) => request.path === '/authorize')).toBe(false);
      expect(provider.requests.some((request) => request.path === '/token')).toBe(false);
    } finally {
      policyLog.mockRestore();
    }
  });

  it('ignores a transient Settings Test Connection snapshot and binds the saved row', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);

    const browserReservation = await reserveBrowserEvent(harness, 'discover');
    const discover = harness.app.service('mcp-servers/discover').create(
      {
        mcp_server_id: harness.server.mcp_server_id,
        url: provider.transientMcpUrl,
        transport: 'sse',
        headers: { 'X-Transient-Config': 'must-not-leave-daemon' },
        auth: {
          type: 'oauth',
          oauth_client_id: 'transient-client-id',
          oauth_compatibility_mode: 'legacy',
        },
        oauth_browser_event: browserReservation,
      },
      paramsFor(harness)
    );

    const authorizationUrl = new URL(
      await Promise.race([
        harness.nextAuthorizationUrl(),
        discover.then((result) => {
          throw new Error(`Discover returned before OAuth start: ${JSON.stringify(result)}`);
        }),
      ])
    );
    expect(authorizationUrl.searchParams.get('client_id')).toBe('saved-client-id');
    expect(authorizationUrl.searchParams.get('resource')).toBe(provider.savedMcpUrl);
    expect(harness.emittedBrowserEvents).toEqual([
      expect.objectContaining({
        authUrl: authorizationUrl.toString(),
        reservation_token: browserReservation.reservation_token,
        caller_user_id: harness.user.user_id,
        attempt_id: expect.any(String),
      }),
    ]);
    expect(provider.requests.some((request) => request.path === '/transient/mcp')).toBe(false);
    expect(provider.requests.some((request) => request.transientHeader)).toBe(false);

    const callback = await harness.callback(authorizationUrl.searchParams.get('state')!);
    expect(callback.status).toBe(200);
    await discover;

    const grant = await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID
    );
    expect(grant?.oauth_resource_uri).toBe(provider.savedMcpUrl);
    expect(grant?.grant_binding_version).toBe(4);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        null,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
  });

  it('never sends A bearer credentials after test-oauth callback when the socket becomes B', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const browserReservation = await reserveBrowserEvent(harness, 'test-oauth');
    const testRequest = harness.app.service('mcp-servers/test-oauth').create(
      {
        mcp_url: provider.savedMcpUrl,
        mcp_server_id: harness.server.mcp_server_id,
        start_browser_flow: true,
        oauth_browser_event: browserReservation,
      },
      paramsFor(harness)
    );
    const authorizationUrl = new URL(await harness.nextAuthorizationUrl());
    const replacementUserId = '01900000-0000-7000-8000-00000000b00b' as UserID;
    let authorityReplaced = false;
    (harness.app.io as { to: () => { emit: (event: string) => void } }).to = () => ({
      emit: (event) => {
        if (event !== 'oauth:completed' || authorityReplaced) return;
        authorityReplaced = true;
        // Completion is emitted after the token is durably persisted and
        // immediately before the raw awaitToken promise resolves. Replace the
        // surviving socket at that exact boundary so the post-await guard —
        // not an earlier provider/DB guard — must stop the bearer probe.
        harness.liveSocket.feathers.user = {
          ...harness.user,
          user_id: replacementUserId,
          email: 'replacement-admin@example.test',
        };
        harness.liveSocket.feathers.authentication = {
          strategy: 'jwt',
          accessToken: 'replacement-admin-authority-token',
        };
      },
    });

    await expect(
      harness.callback(authorizationUrl.searchParams.get('state')!)
    ).resolves.toMatchObject({ status: 200 });
    expect(authorityReplaced).toBe(true);

    await expect(testRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/attempt|authority/i),
    });
    expect(
      provider.requests.filter((request) => request.authorization === 'Bearer sqlite-access-token')
    ).toEqual([]);

    // Callback persistence is intentionally bound to the server-issued A
    // attempt/user/tenant, not to socket lifetime. Only use in the surviving
    // request is socket-bound, so B can neither receive nor send A's token.
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        replacementUserId,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toBeNull();
  });

  it('uses attempt-bound live authority after browser emit instead of the reservation TTL', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const issuedAt = Date.now();
    const browserReservation = await reserveBrowserEvent(harness, 'test-oauth');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 59_999);
    try {
      const testRequest = harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_url: provider.savedMcpUrl,
          mcp_server_id: harness.server.mcp_server_id,
          start_browser_flow: true,
          oauth_browser_event: browserReservation,
        },
        paramsFor(harness)
      );
      const authorizationUrl = new URL(await harness.nextAuthorizationUrl());

      // The pre-browser reservation has done its job. The callback wait is
      // bounded separately and remains usable only by the same live socket,
      // caller, role, tenant, token fingerprint, and server-issued attempt.
      clock.mockReturnValue(issuedAt + 60_001);
      await expect(
        harness.callback(authorizationUrl.searchParams.get('state')!)
      ).resolves.toMatchObject({ status: 200 });
      await expect(testRequest).resolves.toMatchObject({
        success: true,
        tokenValid: true,
        mcpStatus: 200,
      });
      expect(
        provider.requests.filter(
          (request) => request.authorization === 'Bearer sqlite-access-token'
        )
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('consumes reservations once and rejects caller/socket/tenant replacement before provider work', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const request = await reserveBrowserEvent(harness, 'discover');
    const before = provider.requests.length;
    const replacementParams = {
      ...paramsFor(harness),
      user: { ...harness.user, user_id: '01900000-0000-7000-8000-00000000beef' },
    } as AuthenticatedParams & { connection: { id: string } };

    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: request,
        },
        replacementParams
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);

    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: { reservation_token: 'malformed' },
        },
        paramsFor(harness)
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/invalid/i) });
    const unrelatedOperation = await reserveBrowserEvent(harness, 'test-oauth');
    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: unrelatedOperation,
        },
        paramsFor(harness)
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/operation/i) });
    expect(provider.requests).toHaveLength(before);

    // Mismatch consumed the nonce. Neither the original caller nor a replay on
    // another socket can correct and reuse it.
    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: request,
        },
        paramsFor(harness)
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);

    const socketBound = await reserveBrowserEvent(harness, 'discover');
    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: socketBound,
        },
        {
          ...paramsFor(harness),
          connection: { id: 'replacement-socket' },
        } as AuthenticatedParams & {
          connection: { id: string };
        }
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);

    const tokenReservation = await reserveBrowserEvent(harness, 'discover');
    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: { reservation_token: tokenReservation.reservation_token },
        },
        {
          ...paramsFor(harness),
          authentication: { strategy: 'jwt', accessToken: 'replacement-authority-token' },
        } as AuthenticatedParams & { connection: { id: string } }
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);

    const tenantBound = await reserveBrowserEvent(harness, 'discover');
    await expect(
      harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: tenantBound,
        },
        {
          ...paramsFor(harness),
          tenant: { tenant_id: 'other-tenant', source: 'auth' },
        } as AuthenticatedParams & { connection: { id: string } }
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);
  });

  it('abandons a delayed A discovery before provider metadata, DCR, or browser emission after the live socket becomes B', async () => {
    const provider = await createTestProvider({ holdMcpChallenge: true });
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const request = await reserveBrowserEvent(harness, 'discover');

    const discover = harness.app.service('mcp-servers/discover').create(
      {
        mcp_server_id: harness.server.mcp_server_id,
        oauth_browser_event: request,
      },
      paramsFor(harness)
    );
    await provider.mcpRequested.promise;

    // Feathers launch/JWT reauthentication updates the surviving socket's
    // live connection object in place. The original service params still name
    // A, so only a server-side current-socket check can catch this ordering.
    harness.liveSocket.feathers.user = {
      ...harness.user,
      user_id: '01900000-0000-7000-8000-00000000b00b' as UserID,
      email: 'admin-b@example.test',
    };
    provider.releaseMcp();

    await expect(discover).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/authority|reservation/i),
    });
    expect(harness.emittedBrowserEvents).toEqual([]);
    expect(
      provider.requests.filter(
        (request) =>
          request.path.includes('.well-known') ||
          request.path === '/register' ||
          request.path === '/authorize'
      )
    ).toEqual([]);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
  });

  it.each(['role', 'token'] as const)(
    'abandons delayed discovery before provider work when the live socket %s authority changes',
    async (transition) => {
      const provider = await createTestProvider({ holdMcpChallenge: true });
      providers.push(provider);
      const harness = await createHarness(provider);
      databases.push(harness.rawDb);
      const request = await reserveBrowserEvent(harness, 'discover');

      const discover = harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: request,
        },
        paramsFor(harness)
      );
      await provider.mcpRequested.promise;

      if (transition === 'role') {
        harness.liveSocket.feathers.user = {
          ...harness.user,
          role: 'viewer',
        };
      } else {
        harness.liveSocket.feathers.authentication = {
          strategy: 'jwt',
          accessToken: 'replacement-authority-token',
        };
      }
      provider.releaseMcp();

      await expect(discover).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/authority|reservation/i),
      });
      expect(harness.emittedBrowserEvents).toEqual([]);
      expect(
        provider.requests.filter(
          (request) =>
            request.path.includes('.well-known') ||
            request.path === '/register' ||
            request.path === '/authorize'
        )
      ).toEqual([]);
    }
  );

  it('ignores nullish hints and requires a reservation before browser provider effects', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const before = provider.requests.length;

    await expect(
      harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_url: provider.savedMcpUrl,
          mcp_server_id: harness.server.mcp_server_id,
          start_browser_flow: true,
          oauth_browser_event: null,
        } as never,
        paramsFor(harness)
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    await expect(
      harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_url: provider.savedMcpUrl,
          mcp_server_id: harness.server.mcp_server_id,
          start_browser_flow: true,
        },
        paramsFor(harness)
      )
    ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/reservation/i) });
    expect(provider.requests).toHaveLength(before);
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('expires and cleans an unused one-shot reservation at its bounded TTL', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const issuedAt = Date.now();
    const request = await reserveBrowserEvent(harness, 'discover');
    const before = provider.requests.length;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 60_001);
    try {
      await expect(
        harness.app.service('mcp-servers/discover').create(
          {
            mcp_server_id: harness.server.mcp_server_id,
            oauth_browser_event: request,
          },
          paramsFor(harness)
        )
      ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/expired/i) });
    } finally {
      clock.mockRestore();
    }
    expect(provider.requests).toHaveLength(before);
  });

  it('aborts test-oauth when its consumed reservation expires during saved-row DB prep', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const issuedAt = Date.now();
    const request = await reserveBrowserEvent(harness, 'test-oauth');
    const before = provider.requests.length;
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<void>();
    const originalFindById = MCPServerRepository.prototype.findById;
    let holdTargetLookup = true;
    const lookupSpy = vi
      .spyOn(MCPServerRepository.prototype, 'findById')
      .mockImplementation(async function (id: string) {
        if (holdTargetLookup && id === harness.server.mcp_server_id) {
          holdTargetLookup = false;
          lookupStarted.resolve();
          await releaseLookup.promise;
        }
        return originalFindById.call(this, id);
      });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 59_999);
    try {
      const test = harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_url: provider.savedMcpUrl,
          mcp_server_id: harness.server.mcp_server_id,
          start_browser_flow: true,
          oauth_browser_event: request,
        },
        paramsFor(harness)
      );
      await lookupStarted.promise;
      clock.mockReturnValue(issuedAt + 60_001);
      releaseLookup.resolve();

      await expect(test).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/expired/i),
      });
    } finally {
      lookupSpy.mockRestore();
      clock.mockRestore();
    }
    expect(provider.requests).toHaveLength(before);
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it.each(['expiry', 'socket replacement'] as const)(
    'gives %s authority precedence when SQLite grant lookup rejects after provider discovery',
    async (transition) => {
      const provider = await createTestProvider();
      providers.push(provider);
      const harness = await createHarness(provider);
      databases.push(harness.rawDb);
      const issuedAt = Date.now();
      const request = await reserveBrowserEvent(harness, 'discover');
      const lookupStarted = deferred<void>();
      const releaseLookup = deferred<void>();
      const originalGetToken = UserMCPOAuthTokenRepository.prototype.getToken;
      let heldGrantPreparation = false;
      const lookupSpy = vi
        .spyOn(UserMCPOAuthTokenRepository.prototype, 'getToken')
        .mockImplementation(async function (...args) {
          const providerDiscoveryFinished = provider.requests.some(
            (request) => request.path === '/.well-known/oauth-authorization-server'
          );
          if (!heldGrantPreparation && providerDiscoveryFinished) {
            heldGrantPreparation = true;
            lookupStarted.resolve();
            await releaseLookup.promise;
            throw new Error('held SQLite grant lookup failed');
          }
          return originalGetToken.apply(this, args);
        });
      const clock =
        transition === 'expiry'
          ? vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 59_999)
          : undefined;
      try {
        const discover = harness.app.service('mcp-servers/discover').create(
          {
            mcp_server_id: harness.server.mcp_server_id,
            oauth_browser_event: request,
          },
          paramsFor(harness)
        );
        await lookupStarted.promise;
        const requestsAtFailure = provider.requests.map((entry) => ({ ...entry }));

        if (transition === 'expiry') {
          clock!.mockReturnValue(issuedAt + 60_001);
        } else {
          harness.liveSocket.feathers.user = {
            ...harness.user,
            user_id: '01900000-0000-7000-8000-00000000cafe' as UserID,
            email: 'replacement@example.test',
          };
        }
        releaseLookup.resolve();

        await expect(discover).resolves.toMatchObject({
          success: false,
          error: expect.stringMatching(/expired|authority|reservation/i),
        });
        expect(provider.requests).toEqual(requestsAtFailure);
      } finally {
        releaseLookup.resolve();
        lookupSpy.mockRestore();
        clock?.mockRestore();
      }
      expect(harness.emittedBrowserEvents).toEqual([]);
      expect(
        provider.requests.filter((request) => request.authorization?.startsWith('Bearer '))
      ).toEqual([]);
    }
  );

  it('gives expiry precedence when PostgreSQL grant locking rejects after discovery', async () => {
    // This injects the PostgreSQL-only control-flow boundaries into the real
    // registered service while retaining SQLite storage. It proves request
    // continuation ordering, not database rollback. The actual repository +
    // pending-authority rollback contract lives in
    // mcp-oauth-pending-flow-authority.postgres.test.ts.
    const provider = await createTestProvider();
    providers.push(provider);
    const lockStarted = deferred<void>();
    const releaseLock = deferred<void>();
    const durableCreate = vi.fn(async () => {
      throw new Error('durable create must not run');
    });
    const lockGrantConfiguration = vi.fn(async () => {
      lockStarted.resolve();
      await releaseLock.promise;
      throw new Error('held PostgreSQL lock failed');
    });
    const harness = await createHarness(provider, undefined, {
      durableAuthority: durableAuthorityWithCreate(durableCreate),
      lockGrantConfiguration,
    });
    databases.push(harness.rawDb);
    const issuedAt = Date.now();
    const request = await reserveBrowserEvent(harness, 'discover');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 59_999);
    try {
      const discover = harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: request,
        },
        paramsFor(harness)
      );
      await lockStarted.promise;
      const requestsAtFailure = provider.requests.map((entry) => ({ ...entry }));
      clock.mockReturnValue(issuedAt + 60_001);
      releaseLock.resolve();

      await expect(discover).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/expired/i),
      });
      expect(provider.requests).toEqual(requestsAtFailure);
    } finally {
      releaseLock.resolve();
      clock.mockRestore();
    }
    expect(lockGrantConfiguration).toHaveBeenCalledOnce();
    expect(durableCreate).not.toHaveBeenCalled();
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('gives socket replacement precedence when PostgreSQL durable-flow creation rejects', async () => {
    // As above, this is a production service control-flow seam. It is kept
    // explicitly distinct from the live-PostgreSQL atomicity test.
    const provider = await createTestProvider();
    providers.push(provider);
    const createStarted = deferred<void>();
    const releaseCreate = deferred<void>();
    const durableCreate = vi.fn(async () => {
      createStarted.resolve();
      await releaseCreate.promise;
      throw new Error('held PostgreSQL durable create failed');
    });
    const lockGrantConfiguration = vi.fn().mockResolvedValue(undefined);
    const harness = await createHarness(provider, undefined, {
      durableAuthority: durableAuthorityWithCreate(durableCreate),
      lockGrantConfiguration,
    });
    databases.push(harness.rawDb);
    const request = await reserveBrowserEvent(harness, 'discover');
    const discover = harness.app.service('mcp-servers/discover').create(
      {
        mcp_server_id: harness.server.mcp_server_id,
        oauth_browser_event: request,
      },
      paramsFor(harness)
    );
    await createStarted.promise;
    const requestsAtFailure = provider.requests.map((entry) => ({ ...entry }));
    harness.liveSocket.feathers.authentication = {
      strategy: 'jwt',
      accessToken: 'replacement-postgres-authority-token',
    };
    releaseCreate.resolve();

    await expect(discover).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/authority|reservation/i),
    });
    expect(provider.requests).toEqual(requestsAtFailure);
    expect(lockGrantConfiguration).toHaveBeenCalledOnce();
    expect(durableCreate).toHaveBeenCalledOnce();
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('retains the immutable deadline after consumption and aborts held discovery before DCR or browser emit', async () => {
    const provider = await createTestProvider({
      holdMcpChallenge: true,
      rejectDynamicRegistration: true,
    });
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    // If the deadline guard were missing, this legacy no-client row would
    // proceed through provider discovery and POST /register. Existing DCR
    // coverage proves that counterfactual path; this test proves expiry stops
    // it before the first durable provider side effect.
    await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_compatibility_mode: 'legacy',
      },
    });
    const issuedAt = Date.now();
    const request = await reserveBrowserEvent(harness, 'discover');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 59_999);
    try {
      const discover = harness.app.service('mcp-servers/discover').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          oauth_browser_event: request,
        },
        paramsFor(harness)
      );
      await provider.mcpRequested.promise;

      // The map entry has already been consumed. Advancing past its immutable
      // claim deadline must still fence every continuation after the held MCP
      // challenge completes.
      clock.mockReturnValue(issuedAt + 60_001);
      provider.releaseMcp();

      await expect(discover).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/expired/i),
      });
    } finally {
      clock.mockRestore();
    }
    expect(harness.emittedBrowserEvents).toEqual([]);
    expect(
      provider.requests.filter(
        (request) =>
          request.path.includes('.well-known') ||
          request.path === '/register' ||
          request.path === '/authorize'
      )
    ).toEqual([]);
  });

  it('enforces layered socket/user/tenant/global reservation quotas with isolation and TTL recovery', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const service = harness.app.service('mcp-servers/oauth-browser-reservations');
    const issuedAt = Date.now();

    const reserve = (tenant: number, user: number, socket: number) => {
      const params = addLiveAuthority(
        harness,
        `tenant-${tenant}`,
        `tenant-${tenant}-user-${user}`,
        `tenant-${tenant}-user-${user}-socket-${socket}`
      );
      return service.create(
        { operation: 'discover', mcp_server_id: harness.server.mcp_server_id },
        params
      );
    };

    // Fill tenant 1 in layers. Each rejected boundary is followed by a request
    // in the next isolation scope to prove the lower-scope exhaustion is local.
    for (let slot = 0; slot < 8; slot += 1) await reserve(1, 1, 1);
    await expect(reserve(1, 1, 1)).rejects.toThrow(/connection/i);
    await expect(reserve(1, 1, 2)).resolves.toMatchObject({
      reservation_token: expect.any(String),
    });
    // Socket 2 already has one; bring the user's total to 32.
    for (let slot = 1; slot < 8; slot += 1) await reserve(1, 1, 2);
    for (let socket = 3; socket <= 4; socket += 1) {
      for (let slot = 0; slot < 8; slot += 1) await reserve(1, 1, socket);
    }
    await expect(reserve(1, 1, 5)).rejects.toThrow(/user/i);
    await expect(reserve(1, 2, 1)).resolves.toMatchObject({
      reservation_token: expect.any(String),
    });
    // User 2 has one; fill it and two more users to the tenant cap of 128.
    for (let slot = 1; slot < 8; slot += 1) await reserve(1, 2, 1);
    for (let socket = 2; socket <= 4; socket += 1) {
      for (let slot = 0; slot < 8; slot += 1) await reserve(1, 2, socket);
    }
    for (let user = 3; user <= 4; user += 1) {
      for (let socket = 1; socket <= 4; socket += 1) {
        for (let slot = 0; slot < 8; slot += 1) await reserve(1, user, socket);
      }
    }
    await expect(reserve(1, 5, 1)).rejects.toThrow(/tenant/i);
    await expect(reserve(2, 1, 1)).resolves.toMatchObject({
      reservation_token: expect.any(String),
    });

    // Tenant 2 already has one reservation; fill tenants 2–8 to the global
    // cap. Per-tenant caps ensure tenant 1 could not starve tenant 2 by itself.
    for (let tenant = 2; tenant <= 8; tenant += 1) {
      for (let user = 1; user <= 4; user += 1) {
        for (let socket = 1; socket <= 4; socket += 1) {
          for (let slot = 0; slot < 8; slot += 1) {
            if (tenant === 2 && user === 1 && socket === 1 && slot === 0) continue;
            await reserve(tenant, user, socket);
          }
        }
      }
    }
    await expect(reserve(9, 1, 1)).rejects.toThrow(/pending OAuth browser reservations$/i);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 60_001);
    try {
      await expect(reserve(9, 1, 1)).resolves.toMatchObject({
        reservation_token: expect.any(String),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('refuses catalog reuse after a current versioned SQLite grant binding drifts', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user', { catalogPeer: true });
    databases.push(harness.rawDb);

    // Drive the actual OAuth start/callback flow. This is intentionally not a
    // repository-inserted legacy fixture: post-#2491 SQLite grants are bound
    // by the same authority used in production.
    await authorizeSavedServer(harness);
    const tokens = new UserMCPOAuthTokenRepository(harness.rawDb);
    const currentGrant = await tokens.getToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID
    );
    expect(currentGrant?.grant_binding_version).toBe(4);
    expect(currentGrant?.grant_binding_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    // catalog_entry_name participates in the durable fingerprint but not in
    // credential-peer matching. Mutating it therefore isolates the assertion:
    // only hydration's current binding check can remove the credential that
    // would otherwise make connect reuse this row.
    await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
      catalog_entry_name: 'drifted/catalog-stamp',
    });

    const entry = {
      name: 'test/sqlite-current-binding',
      title: 'SQLite Current Binding',
      transport: 'streamable-http',
      remote_url: provider.savedMcpUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
      oauth: { client_id: 'saved-client-id', compatibility_mode: 'strict' },
      permission_disclosure: 'Exercises current SQLite grant binding.',
    } as unknown as MCPCatalogEntry;
    harness.app.use('mcp-catalog', {
      async get() {
        return entry;
      },
    } as never);
    harness.app.use('sessions', {
      async create(data: Record<string, unknown>) {
        return { ...data, session_id: 'sqlite-connect-session' };
      },
      async remove() {},
    } as never);
    harness.app.use('/sessions/:id/mcp-servers', {
      async create(data: unknown) {
        return data;
      },
    } as never);

    const result = await createRegisteredMCPCatalogConnectService(harness.app, harness.db).create(
      {
        catalog_key: entry.name,
        branch_id: 'sqlite-binding-branch',
        agentic_tool: 'claude-code',
        acknowledged_disclosure: entry.permission_disclosure,
      },
      { ...paramsFor(harness), provider: 'rest' }
    );

    expect(result.reused_existing_server).toBe(false);
    expect(result.mcp_server.mcp_server_id).not.toBe(harness.server.mcp_server_id);
    await expect(
      tokens.getToken(harness.user.user_id as UserID, harness.server.mcp_server_id as MCPServerID)
    ).resolves.toBeNull();
  });

  it('rejects a saved-row mutation that lands while the provider token exchange is running', async () => {
    const provider = await createTestProvider({ holdToken: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      success: boolean;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    const authorizationUrl = new URL(started.authorizationUrl);

    const callback = harness.callback(authorizationUrl.searchParams.get('state')!);
    await provider.tokenRequested.promise;
    await harness.app
      .service('mcp-servers')
      .patch(
        harness.server.mcp_server_id,
        { headers: { 'X-Saved-Config': 'mutated-during-exchange' } },
        paramsFor(harness)
      );
    provider.releaseToken();

    expect((await callback).status).not.toBe(200);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
  });

  it('/test-oauth defaults an omitted oauth_mode to a per-user grant', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);

    const browserReservation = await reserveBrowserEvent(harness, 'test-oauth');
    const testRequest = harness.app.service('mcp-servers/test-oauth').create(
      {
        mcp_url: provider.savedMcpUrl,
        mcp_server_id: harness.server.mcp_server_id,
        start_browser_flow: true,
        oauth_browser_event: browserReservation,
      },
      paramsFor(harness)
    );
    const authorizationUrl = new URL(await harness.nextAuthorizationUrl());
    expect((await harness.callback(authorizationUrl.searchParams.get('state')!)).status).toBe(200);
    await expect(testRequest).resolves.toMatchObject({ success: true });

    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).not.toBeNull();
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        null,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
  });

  it('does not resurrect a grant deleted by a Settings mutation during refresh', async () => {
    const provider = await createTestProvider({ holdRefresh: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const refresh = harness.app
      .service('mcp-servers/oauth-refresh')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await Promise.race([
      provider.refreshRequested.promise,
      refresh.then((result) => {
        throw new Error(`Refresh returned before provider exchange: ${JSON.stringify(result)}`);
      }),
    ]);
    await harness.app
      .service('mcp-servers')
      .patch(
        harness.server.mcp_server_id,
        { headers: { 'X-Saved-Config': 'mutated-during-refresh' } },
        paramsFor(harness)
      );
    provider.releaseRefresh();

    await expect(refresh).resolves.toMatchObject({ success: false, error: 'needs_reauth' });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toBeNull();
  });

  it('does not let an old refresh overwrite a newer authorization generation', async () => {
    const provider = await createTestProvider({ holdRefresh: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const refresh = harness.app
      .service('mcp-servers/oauth-refresh')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await Promise.race([
      provider.refreshRequested.promise,
      refresh.then((result) => {
        throw new Error(`Refresh returned before provider exchange: ${JSON.stringify(result)}`);
      }),
    ]);
    const generation = await replaceWithNewAuthorization(harness);
    provider.releaseRefresh();

    await expect(refresh).resolves.toMatchObject({ success: false, error: 'needs_reauth' });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      grant_generation: generation,
      oauth_access_token: 'new-authorization-access-token',
      oauth_refresh_token: 'new-authorization-refresh-token',
    });
  });

  it('does not let stale invalid_grant delete a newer authorization', async () => {
    const provider = await createTestProvider({ holdRefresh: true, invalidRefresh: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const refresh = harness.app
      .service('mcp-servers/oauth-refresh')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await Promise.race([
      provider.refreshRequested.promise,
      refresh.then((result) => {
        throw new Error(`Refresh returned before provider exchange: ${JSON.stringify(result)}`);
      }),
    ]);
    const generation = await replaceWithNewAuthorization(harness);
    provider.releaseRefresh();

    await expect(refresh).resolves.toMatchObject({ success: false, error: 'needs_reauth' });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      grant_generation: generation,
      oauth_access_token: 'new-authorization-access-token',
    });
  });

  it.each([
    {
      mode: 'per_user' as const,
      name: 'lower generation commits first',
      order: 'lower-first' as const,
    },
    {
      mode: 'per_user' as const,
      name: 'higher generation commits first',
      order: 'higher-first' as const,
    },
    { mode: 'per_user' as const, name: 'both empty-row writes race', order: 'concurrent' as const },
    {
      mode: 'shared' as const,
      name: 'lower generation commits first',
      order: 'lower-first' as const,
    },
    {
      mode: 'shared' as const,
      name: 'higher generation commits first',
      order: 'higher-first' as const,
    },
    { mode: 'shared' as const, name: 'both empty-row writes race', order: 'concurrent' as const },
  ])('keeps the higher first-time $mode callback when $name', async ({ mode, order }) => {
    const provider = await createTestProvider({
      holdTokenRequests: [1, 2],
      numberedTokenResponses: true,
    });
    providers.push(provider);
    const harness = await createHarness(provider, mode);
    databases.push(harness.rawDb);

    const start = async (): Promise<string> => {
      const result = (await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
        authorizationUrl: string;
      };
      return new URL(result.authorizationUrl).searchParams.get('state')!;
    };

    // Both one-shot callbacks are claimed and blocked inside their provider
    // exchanges while the grant subject is still empty.
    const callbackA = harness.callback(await start());
    await provider.waitForTokenRequest(1);
    const callbackB = harness.callback(await start());
    await provider.waitForTokenRequest(2);

    let emptyReadBarrierSpy: ReturnType<typeof vi.spyOn> | undefined;
    if (order === 'concurrent') {
      // Deterministically reproduce the old read-then-insert race: if callback
      // persistence performs an empty-row read, hold the first until both have
      // observed null. The atomic upsert correctly performs no such read.
      const originalGetToken = UserMCPOAuthTokenRepository.prototype.getToken;
      const bothEmptyReads = deferred<void>();
      let emptyReadCount = 0;
      emptyReadBarrierSpy = vi
        .spyOn(UserMCPOAuthTokenRepository.prototype, 'getToken')
        .mockImplementation(async function (userId, serverId) {
          const row = await originalGetToken.call(this, userId, serverId);
          if (row) return row;
          emptyReadCount += 1;
          if (emptyReadCount === 2) bothEmptyReads.resolve();
          await bothEmptyReads.promise;
          return null;
        });
    }

    let resultA: { status: number; body: string };
    let resultB: { status: number; body: string };
    try {
      if (order === 'lower-first') {
        provider.releaseTokenRequest(1);
        resultA = await callbackA;
        provider.releaseTokenRequest(2);
        resultB = await callbackB;
      } else if (order === 'higher-first') {
        provider.releaseTokenRequest(2);
        resultB = await callbackB;
        provider.releaseTokenRequest(1);
        resultA = await callbackA;
      } else {
        provider.releaseTokenRequest(1);
        provider.releaseTokenRequest(2);
        [resultA, resultB] = await Promise.all([callbackA, callbackB]);
      }
    } finally {
      emptyReadBarrierSpy?.mockRestore();
    }

    expect(resultB.status).toBe(200);
    if (order === 'lower-first') expect(resultA.status).toBe(200);

    const repository = new UserMCPOAuthTokenRepository(harness.rawDb);
    const subjectUserId = mode === 'per_user' ? (harness.user.user_id as UserID) : null;
    const durable = await repository.getToken(
      subjectUserId,
      harness.server.mcp_server_id as MCPServerID
    );
    expect(durable).toMatchObject({
      user_id: subjectUserId,
      mcp_server_id: harness.server.mcp_server_id,
      grant_generation: 2,
      grant_binding_version: 4,
      oauth_access_token: 'sqlite-access-token-2',
      oauth_refresh_token: 'refresh-2',
      oauth_client_id: 'saved-client-id',
      oauth_resource_uri: provider.savedMcpUrl,
    });
    expect(durable?.grant_binding_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const attemptReplacement = (generation: number, accessToken: string) =>
      repository.saveToken(subjectUserId, harness.server.mcp_server_id as MCPServerID, {
        accessToken,
        refreshToken: `${accessToken}-refresh`,
        clientId: durable!.oauth_client_id,
        grantBinding: {
          generation,
          version: 4,
          fingerprint: durable!.grant_binding_fingerprint!,
          metadataUri: durable!.oauth_metadata_uri!,
          resourceUri: durable!.oauth_resource_uri!,
          issuer: durable!.oauth_issuer!,
          authorizationEndpoint: durable!.oauth_authorization_endpoint!,
          tokenEndpoint: durable!.oauth_token_endpoint!,
          redirectUri: durable!.oauth_redirect_uri!,
        },
      });
    await expect(attemptReplacement(1, 'lower-generation')).rejects.toThrow(
      'A newer MCP OAuth grant superseded this attempt'
    );
    await expect(attemptReplacement(2, 'equal-generation')).rejects.toThrow(
      'A newer MCP OAuth grant superseded this attempt'
    );
    await expect(
      repository.getToken(subjectUserId, harness.server.mcp_server_id as MCPServerID)
    ).resolves.toMatchObject({
      grant_generation: 2,
      oauth_access_token: 'sqlite-access-token-2',
    });
    await expect(
      repository.getToken(
        mode === 'per_user' ? null : (harness.user.user_id as UserID),
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toBeNull();
  });

  it('never reuses a released generation while an older callback is exchanging', async () => {
    const provider = await createTestProvider({
      holdTokenRequests: [1],
      numberedTokenResponses: true,
    });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);

    const start = async (): Promise<string> => {
      const result = (await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
        authorizationUrl: string;
      };
      return new URL(result.authorizationUrl).searchParams.get('state')!;
    };

    // A owns generation 1 and has already been claimed/removed from pending
    // state, but its provider exchange remains active.
    const stateA = await start();
    const callbackA = harness.callback(stateA);
    await provider.tokenRequested.promise;

    // B owns generation 2, then fails and releases only its own reservation.
    const stateB = await start();
    expect((await harness.deny(stateB)).status).toBe(400);

    // C must allocate generation 3, never reuse generation 1 after B releases.
    const stateC = await start();
    expect((await harness.callback(stateC)).status).toBe(200);
    const repository = new UserMCPOAuthTokenRepository(harness.rawDb);
    await expect(
      repository.getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      grant_generation: 3,
      oauth_access_token: 'sqlite-access-token-2',
      oauth_refresh_token: 'refresh-2',
    });

    // When A eventually completes, older/equal-generation update fencing and
    // exact deletion must leave C's grant untouched.
    provider.releaseToken();
    expect((await callbackA).status).not.toBe(200);
    await expect(
      repository.getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      grant_generation: 3,
      oauth_access_token: 'sqlite-access-token-2',
      oauth_refresh_token: 'refresh-2',
    });

    const grantC = await repository.getToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID
    );
    expect(grantC?.grant_binding_fingerprint).toBeTruthy();
    await expect(
      repository.saveToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID,
        {
          accessToken: 'same-generation-different-attempt',
          refreshToken: 'must-not-replace-c',
          clientId: grantC!.oauth_client_id,
          grantBinding: {
            generation: 3,
            version: 4,
            fingerprint: grantC!.grant_binding_fingerprint!,
            metadataUri: grantC!.oauth_metadata_uri!,
            resourceUri: grantC!.oauth_resource_uri!,
            issuer: grantC!.oauth_issuer!,
            authorizationEndpoint: grantC!.oauth_authorization_endpoint!,
            tokenEndpoint: grantC!.oauth_token_endpoint!,
            redirectUri: grantC!.oauth_redirect_uri!,
          },
        }
      )
    ).rejects.toThrow('A newer MCP OAuth grant superseded this attempt');
    await expect(
      repository.getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      grant_generation: 3,
      oauth_access_token: 'sqlite-access-token-2',
    });
  });
});
