import http, { type Server as HttpServer } from 'node:http';
import {
  createDatabaseAsync,
  eq,
  MCPServerRepository,
  mcpServers,
  runMigrations,
  shortId,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  update,
} from '@agor/core/db';
import {
  type Application,
  AuthenticationService,
  feathers,
  feathersExpress,
  socketio,
  socketioClient,
} from '@agor/core/feathers';
import { loadCatalog } from '@agor/core/mcp-catalog';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPOAuthBrowserEventRequest,
  MCPOAuthBrowserReservation,
  MCPServer,
  MCPServerID,
  User,
  UserID,
} from '@agor/core/types';
import type { OutboundDnsLookup } from '@agor/core/utils/safe-outbound-fetch';
import { type Socket as ClientSocket, io as createSocketClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeJWTStrategy } from './auth/runtime-jwt-strategy.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './auth/runtime-tokens.js';
import { createRegisteredMCPCatalogConnectService } from './register-routes.js';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';
import { createSocketIOConfig } from './setup/socketio.js';
import {
  AGOR_SOCKET_AUTHORITY_ID_PROPERTY,
  installSocketAuthorityId,
  readSocketAuthorityId,
} from './utils/socket-request-authority.js';

// The boundary under test is daemon discovery/OAuth authority, not the MCP
// SDK's stream parser. Mock only the post-grant capability client so Vitest
// does not try to type-strip eventsource-parser's published TypeScript file.
const mcpClientTestState = vi.hoisted(() => ({
  connectError: undefined as unknown,
  tools: [] as Array<{ name: string; description?: string }>,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {
      if (mcpClientTestState.connectError) throw mcpClientTestState.connectError;
    }
    async close() {}
    async listTools() {
      return { tools: mcpClientTestState.tools };
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
  dcrRequested: Deferred<void>;
  releaseToken: () => void;
  releaseTokenRequest: (requestNumber: number) => void;
  waitForTokenRequest: (requestNumber: number) => Promise<void>;
  releaseRefresh: () => void;
  releaseMcp: () => void;
  releaseDcr: () => void;
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
    holdDynamicRegistration?: boolean;
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
  const dcrRequested = deferred<void>();
  const releaseDcr = deferred<void>();
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
          ...(options.rejectDynamicRegistration || options.holdDynamicRegistration
            ? { registration_endpoint: `${baseUrl}/register` }
            : {}),
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          // The DCR fixture deliberately omits RFC 9207 response-issuer
          // support. Reaching /register therefore proves that the canonical
          // catalog row selected Marketplace policy rather than strict.
          ...(options.rejectDynamicRegistration || options.holdDynamicRegistration
            ? {}
            : { authorization_response_iss_parameter_supported: true }),
        })
      );
      return;
    }
    if (
      url.pathname === '/register' &&
      (options.rejectDynamicRegistration || options.holdDynamicRegistration)
    ) {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      recordedRequest.jsonBody = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      dcrRequested.resolve();
      if (options.holdDynamicRegistration) {
        await releaseDcr.promise;
        const redirectUris = Array.isArray(recordedRequest.jsonBody?.redirect_uris)
          ? recordedRequest.jsonBody.redirect_uris
          : [];
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            client_id: 'held-dcr-client',
            redirect_uris: redirectUris,
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          })
        );
        return;
      }
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
    if (url.pathname === '/jwt') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      recordedRequest.jsonBody = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'jwt-provider-token' }));
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
    dcrRequested,
    releaseToken: () => {
      for (const gate of tokenReleaseGates.values()) gate.resolve();
    },
    releaseTokenRequest: (requestNumber: number) => tokenReleaseGate(requestNumber).resolve(),
    waitForTokenRequest: (requestNumber: number) => tokenRequestMilestone(requestNumber).promise,
    releaseRefresh: () => releaseRefresh.resolve(),
    releaseMcp: () => releaseMcp.resolve(),
    releaseDcr: () => releaseDcr.resolve(),
    close: () => {
      for (const gate of tokenReleaseGates.values()) gate.resolve();
      releaseRefresh.resolve();
      releaseMcp.resolve();
      releaseDcr.resolve();
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
    feathers: AuthenticatedParams;
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
    outboundDnsLookup?: OutboundDnsLookup;
    requireAuth?: RegisterServicesContext['requireAuth'];
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
      user,
      authentication: {
        strategy: 'jwt',
        accessToken: 'sqlite-initial-authority-token',
      },
    } as AuthenticatedParams,
    data: { tenant: { tenant_id: 'default', source: 'static' } },
  };
  installSocketAuthorityId(
    liveSocket.feathers as unknown as Record<PropertyKey, unknown>,
    liveSocket.id
  );
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
    requireAuth: options.requireAuth ?? (async (context) => context),
    deployment: {} as RegisterServicesContext['deployment'],
    mcpOAuthPendingFlowAuthority: options.durableAuthority,
    lockMcpOAuthGrantConfiguration: options.lockGrantConfiguration,
    mcpOutboundDnsLookup: options.outboundDnsLookup,
  });
  // The production registerHooks chain turns the catalog service's private
  // params capability into the persisted provenance stamp. This service-only
  // harness installs that narrow seam explicitly so the repository's trusted
  // CREATE contract can reject incomplete catalog provenance.
  app.service('mcp-servers').hooks({
    before: {
      create: [
        (context) => {
          const entryName = (
            context.params as AuthenticatedParams & {
              mcpCatalogInstall?: { entry_name?: string };
            }
          ).mcpCatalogInstall?.entry_name;
          if (entryName && context.data && !Array.isArray(context.data)) {
            context.data.catalog_entry_name = entryName;
          }
          return context;
        },
      ],
    },
  } as never);

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

function paramsFor(harness: SQLiteHarness): AuthenticatedParams {
  return {
    provider: 'socketio',
    user: harness.liveSocket.feathers.user,
    tenant: { tenant_id: 'default', source: 'static' },
    connection: harness.liveSocket.feathers,
    authentication: harness.liveSocket.feathers.authentication,
  } as AuthenticatedParams;
}

function replaceLiveSocketAuthority(harness: SQLiteHarness, suffix = 'replacement'): void {
  harness.liveSocket.feathers.user = {
    ...harness.user,
    user_id: `01900000-0000-7000-8000-${suffix.padStart(12, '0').slice(-12)}` as UserID,
    email: `${suffix}@example.test`,
  };
  harness.liveSocket.feathers.authentication = {
    strategy: 'jwt',
    accessToken: `${suffix}-authority-token`,
  };
}

function addLiveAuthority(
  harness: SQLiteHarness,
  tenantId: string,
  userId: string,
  socketId: string
): AuthenticatedParams {
  const user = {
    ...harness.user,
    user_id: userId as UserID,
    email: `${userId}@example.test`,
    role: 'member' as const,
  };
  const connection = {
    user,
    authentication: {
      strategy: 'jwt',
      accessToken: `token:${tenantId}:${userId}:${socketId}`,
    },
  } as AuthenticatedParams;
  installSocketAuthorityId(connection as unknown as Record<PropertyKey, unknown>, socketId);
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
    provider: 'socketio',
    user,
    tenant: { tenant_id: tenantId, source: 'auth' },
    connection,
    authentication: connection.authentication,
  } as AuthenticatedParams;
}

async function reserveBrowserEvent(
  harness: SQLiteHarness,
  operation: 'discover' | 'test-oauth'
): Promise<MCPOAuthBrowserEventRequest> {
  const reservation = await createBrowserEventReservation(harness, operation);
  return { reservation_token: reservation.reservation_token };
}

async function reserveBrowserEventWithDeadline(
  harness: SQLiteHarness,
  operation: 'discover' | 'test-oauth'
): Promise<{ event: MCPOAuthBrowserEventRequest; expiresAt: number }> {
  // The async reservation boundary may cross a wall-clock tick under load.
  // Expiry tests must advance from the daemon-issued deadline, not a timestamp
  // sampled before the request, or they can remain accidentally unexpired.
  const reservation = await createBrowserEventReservation(harness, operation);
  return {
    event: { reservation_token: reservation.reservation_token },
    expiresAt: reservation.expires_at,
  };
}

async function createBrowserEventReservation(
  harness: SQLiteHarness,
  operation: 'discover' | 'test-oauth'
): Promise<MCPOAuthBrowserReservation> {
  const reservation = (await harness.app
    .service('mcp-servers/oauth-browser-reservations')
    .create(
      { operation, mcp_server_id: harness.server.mcp_server_id },
      paramsFor(harness)
    )) as MCPOAuthBrowserReservation;
  return reservation;
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

const REAL_SOCKET_JWT_SECRET = 'real-socket-authority-integration-secret';

type RealSocketHarness = {
  app: Application & { io: import('socket.io').Server };
  rawDb: Awaited<ReturnType<typeof createDatabaseAsync>>;
  userA: User;
  userB: User;
  serverRow: MCPServer;
  httpServer: HttpServer;
  client: Application;
  clientSocket: ClientSocket;
  replaceAuthorityWithB: () => Promise<void>;
  close: () => Promise<void>;
};

function waitForClientSocket(socket: ClientSocket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out connecting real Socket.IO client')),
      5_000
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function createRealSocketHarness(
  provider: TestProvider,
  options: { outboundDnsLookup?: OutboundDnsLookup } = {}
): Promise<RealSocketHarness> {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const users = new UsersRepository(rawDb);
  const userA = await users.create({
    email: `real-socket-a-${Math.random()}@example.test`,
    role: 'admin',
  });
  const userB = await users.create({
    email: `real-socket-b-${Math.random()}@example.test`,
    role: 'admin',
  });
  const serverRow = await new MCPServerRepository(rawDb).create({
    name: 'real-socket-oauth-authority',
    transport: 'http',
    url: provider.savedMcpUrl,
    scope: 'global',
    owner_user_id: userA.user_id as UserID,
    auth: { type: 'oauth', oauth_client_id: 'saved-client-id', oauth_mode: 'per_user' },
  });

  const app = feathersExpress(feathers()) as unknown as Application & {
    io: import('socket.io').Server;
    listen: (port: number, hostname: string) => Promise<HttpServer>;
  };
  app.use('/users', {
    async get(id: string) {
      const user = await users.findById(id);
      if (!user) throw new Error('Unknown socket test user');
      return user;
    },
  } as never);
  const multiTenancy = {
    mode: 'static',
    static_tenant_id: 'default',
  } as const;
  app.set('authentication', {
    secret: REAL_SOCKET_JWT_SECRET,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
    },
  });
  const authentication = new AuthenticationService(app);
  authentication.register('jwt', new RuntimeJWTStrategy({ multiTenancy }));
  app.use('authentication', authentication);
  app.use('/socket-authority-inspect', {
    async find(params?: AuthenticatedParams) {
      const descriptor = params?.connection
        ? Object.getOwnPropertyDescriptor(params.connection, AGOR_SOCKET_AUTHORITY_ID_PROPERTY)
        : undefined;
      return {
        provider: params?.provider,
        authorityId: readSocketAuthorityId(params?.connection),
        plainId: (params?.connection as { id?: unknown } | undefined)?.id,
        enumerable: descriptor?.enumerable,
        configurable: descriptor?.configurable,
        writable: descriptor?.writable,
      };
    },
  } as never);
  const socketConfig = createSocketIOConfig(app, {
    corsOrigin: '*',
    credentialsAllowed: false,
    jwtSecret: REAL_SOCKET_JWT_SECRET,
    multiTenancy,
  });
  app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
  await registerMCPServices({
    db: rawDb as unknown as TenantScopeAwareDatabase,
    app,
    config: {} as RegisterServicesContext['config'],
    jwtSecret: REAL_SOCKET_JWT_SECRET,
    daemonUrl: 'http://127.0.0.1:3030',
    bundledUiAvailable: false,
    DAEMON_PORT: 3030,
    UI_PORT: 5173,
    branchRbacEnabled: false,
    allowSuperadmin: false,
    requireAuth: async (context) => {
      if (context.params.provider === 'socketio' && !context.params.user) {
        throw new Error('Unauthenticated Socket.IO integration request');
      }
      context.params.tenant = { tenant_id: 'default', source: 'static' };
      return context;
    },
    deployment: {} as RegisterServicesContext['deployment'],
    mcpOutboundDnsLookup: options.outboundDnsLookup,
  });

  const httpServer = await app.listen(0, '127.0.0.1');
  if (!httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
  }
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected Socket.IO test listener');
  const accessToken = issueRuntimeToken(
    { sub: userA.user_id, type: 'access' },
    REAL_SOCKET_JWT_SECRET,
    '5m'
  );
  const clientSocket = createSocketClient(`http://127.0.0.1:${address.port}`, {
    auth: { token: accessToken },
    transports: ['websocket'],
    reconnection: false,
  });
  const client = feathers();
  client.configure(socketioClient(clientSocket));
  await waitForClientSocket(clientSocket);

  const replacementSockets: ClientSocket[] = [];
  const replaceAuthorityWithB = async (): Promise<void> => {
    // Newer-main makes socket authority immutable for the physical handshake:
    // an A -> B transition retires A's registry entry and establishes B on a
    // new socket. Remove A from the authoritative live map without tearing
    // down its test transport yet, so the already-running RPC can deliver its
    // expected authority rejection acknowledgement to the client.
    app.io.sockets.sockets.delete(clientSocket.id!);

    const replacementToken = issueRuntimeToken(
      { sub: userB.user_id, type: 'access' },
      REAL_SOCKET_JWT_SECRET,
      '5m'
    );
    const replacement = createSocketClient(`http://127.0.0.1:${address.port}`, {
      auth: { token: replacementToken },
      transports: ['websocket'],
      reconnection: false,
    });
    replacementSockets.push(replacement);
    await waitForClientSocket(replacement);
  };

  let closed = false;
  return {
    app,
    rawDb,
    userA,
    userB,
    serverRow,
    httpServer,
    client,
    clientSocket,
    replaceAuthorityWithB,
    close: async () => {
      if (closed) return;
      closed = true;
      clientSocket.close();
      for (const replacement of replacementSockets) replacement.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve()))
      );
      (rawDb as unknown as { $client?: { close(): void } }).$client?.close();
    },
  };
}

const providers: TestProvider[] = [];
const databases: SQLiteHarness['rawDb'][] = [];
const realSocketHarnesses: RealSocketHarness[] = [];
let previousBaseUrl: string | undefined;
let previousMasterSecret: string | undefined;

beforeEach(() => {
  previousBaseUrl = process.env.AGOR_BASE_URL;
  previousMasterSecret = process.env.AGOR_MASTER_SECRET;
  process.env.AGOR_BASE_URL = 'https://agor.example.test';
  process.env.AGOR_MASTER_SECRET = 'a'.repeat(64);
});

afterEach(async () => {
  mcpClientTestState.connectError = undefined;
  mcpClientTestState.tools = [];
  await Promise.all(realSocketHarnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const db of databases.splice(0)) {
    (db as unknown as { $client?: { close(): void } }).$client?.close();
  }
  if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
  else process.env.AGOR_BASE_URL = previousBaseUrl;
  if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
  else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
});

describe('saved-server capability discovery', () => {
  it('persists protocol-valid multiline tool descriptions', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    const server = await new MCPServerRepository(harness.rawDb).create({
      name: 'multiline-description-server',
      transport: 'http',
      url: provider.savedMcpUrl,
      scope: 'global',
      owner_user_id: harness.user.user_id as UserID,
      auth: { type: 'none' },
    });
    mcpClientTestState.tools = [
      {
        name: 'resolve-library-id',
        description: 'Resolve a library.\n\nRules:\n- prefer an exact match\n- explain ambiguity',
      },
    ];

    await expect(
      harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: server.mcp_server_id }, paramsFor(harness))
    ).resolves.toMatchObject({
      success: true,
      tools: mcpClientTestState.tools,
    });
    await expect(
      new MCPServerRepository(harness.rawDb).findById(server.mcp_server_id)
    ).resolves.toMatchObject({ tools: mcpClientTestState.tools });
  });

  it('reports Agor persistence-policy rejection without blaming the provider or echoing it', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    const server = await new MCPServerRepository(harness.rawDb).create({
      name: 'invalid-description-server',
      transport: 'http',
      url: provider.savedMcpUrl,
      scope: 'global',
      owner_user_id: harness.user.user_id as UserID,
      auth: { type: 'none' },
    });
    mcpClientTestState.tools = [{ name: 'unsafe', description: 'provider-secret\0suffix' }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: server.mcp_server_id }, paramsFor(harness));

      expect(result).toMatchObject({
        success: false,
        category: 'storage_policy_rejected',
        action: 'contact_admin',
        error:
          "The MCP server's capabilities did not meet Agor's storage safety limits, so Agor did not save them. Ask an administrator to review the secure operational event.",
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '[MCP Discovery] event=mcp_external_failure stage=discovery category=storage_policy_rejected type=Error reason=capability_persistence_validation_rejected'
      );
      expect(JSON.stringify({ result, logs: errorSpy.mock.calls })).not.toContain(
        'provider-secret'
      );
      await expect(
        new MCPServerRepository(harness.rawDb).findById(server.mcp_server_id)
      ).resolves.toMatchObject({ tools: undefined });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('real Feathers Socket.IO request authority', () => {
  it('binds params.connection to the immutable physical socket and ignores spoofed ids', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createRealSocketHarness(provider);
    realSocketHarnesses.push(harness);

    const inspected = (await harness.client.service('socket-authority-inspect').find()) as {
      provider?: string;
      authorityId?: string;
      plainId?: unknown;
      enumerable?: boolean;
      configurable?: boolean;
      writable?: boolean;
    };
    expect(inspected).toEqual({
      provider: 'socketio',
      authorityId: harness.clientSocket.id,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    const reservation = (await harness.client
      .service('mcp-servers/oauth-browser-reservations')
      .create({
        operation: 'discover',
        mcp_server_id: harness.serverRow.mcp_server_id,
        // Neither a documented field nor this namespaced value can influence
        // the server-derived transport binding.
        socket_id: 'attacker-supplied-id',
        [AGOR_SOCKET_AUTHORITY_ID_PROPERTY]: 'attacker-supplied-id',
      })) as { reservation_token?: string };
    expect(reservation.reservation_token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);

    const realConnection = harness.app.io.sockets.sockets.get(harness.clientSocket.id!)?.feathers;
    expect(realConnection).toBeDefined();
    const fakeConnection = {
      id: harness.clientSocket.id,
      user: harness.userA,
      authentication: realConnection?.authentication,
    } as AuthenticatedParams;
    installSocketAuthorityId(
      fakeConnection as unknown as Record<PropertyKey, unknown>,
      harness.clientSocket.id!
    );
    await expect(
      harness.app
        .service('mcp-servers/oauth-browser-reservations')
        .create({ operation: 'discover', mcp_server_id: harness.serverRow.mcp_server_id }, {
          provider: 'socketio',
          connection: fakeConnection,
          user: harness.userA,
          authentication: fakeConnection.authentication,
          tenant: { tenant_id: 'default', source: 'static' },
        } as AuthenticatedParams)
    ).rejects.toThrow(/live socket/i);
    await expect(
      harness.app.service('mcp-servers/test-jwt').create(
        {
          api_url: `${provider.baseUrl}/jwt`,
          api_token: 'must-not-dispatch',
          api_secret: 'must-not-dispatch',
        },
        {
          provider: 'socketio',
          connection: { id: harness.clientSocket.id },
          user: harness.userA,
          tenant: { tenant_id: 'default', source: 'static' },
        } as AuthenticatedParams
      )
    ).rejects.toThrow(/socket.*authority/i);
    expect(provider.requests).toEqual([]);
  });

  it('drops one-shot reservations as soon as the physical socket disconnects', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createRealSocketHarness(provider);
    realSocketHarnesses.push(harness);
    const reserved = (await harness.client
      .service('mcp-servers/oauth-browser-reservations')
      .create({ operation: 'test-oauth', mcp_server_id: harness.serverRow.mcp_server_id })) as {
      reservation_token: string;
    };

    const disconnected = new Promise<void>((resolve) => {
      const serverSocket = harness.app.io.sockets.sockets.get(harness.clientSocket.id!);
      serverSocket?.once('disconnect', () => resolve());
    });
    harness.clientSocket.close();
    await disconnected;

    await expect(
      harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_url: provider.savedMcpUrl,
          mcp_server_id: harness.serverRow.mcp_server_id,
          start_browser_flow: true,
          oauth_browser_event: { reservation_token: reserved.reservation_token },
        },
        {
          provider: 'rest',
          user: harness.userB,
          tenant: { tenant_id: 'default', source: 'static' },
        } as AuthenticatedParams
      )
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/authority|reservation|expired/i),
    });
    expect(provider.requests).toEqual([]);
  });

  it('fences A secrets at held DNS on a genuine test-jwt socket call', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const dnsStarted = deferred<void>();
    const releaseDns = deferred<void>();
    const harness = await createRealSocketHarness(provider, {
      outboundDnsLookup: async (hostname) => {
        expect(hostname).toBe('localhost');
        dnsStarted.resolve();
        await releaseDns.promise;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    realSocketHarnesses.push(harness);

    const request = harness.client.service('mcp-servers/test-jwt').create({
      api_url: `${provider.baseUrl.replace('127.0.0.1', 'localhost')}/jwt`,
      api_token: 'admin-a-api-token',
      api_secret: 'admin-a-api-secret',
    });
    await dnsStarted.promise;
    await harness.replaceAuthorityWithB();
    releaseDns.resolve();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests).toEqual([]);
  });

  it('sanitizes a secret-bearing DNS exception on a genuine test-jwt socket call', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const sentinel = 'SENTINEL_REAL_SOCKET_DNS_1b7e';
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const hostileFailure = new TypeError(`DNS reflected https://${sentinel}.example.test`);
    Object.defineProperties(hostileFailure, {
      name: { get: getter },
      code: { get: getter },
    });
    const harness = await createRealSocketHarness(provider, {
      outboundDnsLookup: async () => {
        throw hostileFailure;
      },
    });
    realSocketHarnesses.push(harness);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realtimeSpy = vi.fn();
    for (const event of ['created', 'updated', 'patched', 'removed'] as const) {
      harness.client.service('mcp-servers').on(event, realtimeSpy);
    }
    try {
      const result = await harness.client.service('mcp-servers/test-jwt').create({
        api_url: 'https://auth.example.test/token',
        api_token: 'configured',
        api_secret: sentinel,
      });
      expect(result).toMatchObject({ success: false, category: 'provider_unavailable' });
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(await new MCPServerRepository(harness.rawDb).findAll())).not.toContain(
        sentinel
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(realtimeSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fences oauth-start when A becomes B during the authoritative DB read', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createRealSocketHarness(provider);
    realSocketHarnesses.push(harness);
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const originalFindById = MCPServerRepository.prototype.findById;
    let held = false;
    const findSpy = vi
      .spyOn(MCPServerRepository.prototype, 'findById')
      .mockImplementation(async function (id) {
        const result = await originalFindById.call(this, id);
        if (id === harness.serverRow.mcp_server_id && !held) {
          held = true;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return result;
      });
    try {
      const request = harness.client
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.serverRow.mcp_server_id });
      await readStarted.promise;
      await harness.replaceAuthorityWithB();
      releaseRead.resolve();

      await expect(request).rejects.toThrow(/authority/i);
      expect(provider.requests).toEqual([]);
    } finally {
      releaseRead.resolve();
      findSpy.mockRestore();
    }
  });

  it('fences oauth-start after a held initialize probe before discovery or flow creation', async () => {
    const provider = await createTestProvider({ holdMcpChallenge: true });
    providers.push(provider);
    const harness = await createRealSocketHarness(provider);
    realSocketHarnesses.push(harness);

    const request = harness.client
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.serverRow.mcp_server_id });
    await provider.mcpRequested.promise;
    await harness.replaceAuthorityWithB();
    provider.releaseMcp();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests.map((entry) => entry.path)).toEqual(['/saved/mcp']);
    expect(
      provider.requests.some(
        (entry) => entry.path.startsWith('/.well-known/') || entry.path === '/register'
      )
    ).toBe(false);
  });

  it('keeps REST and internal calls on their non-socket request authority models', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createRealSocketHarness(provider);
    realSocketHarnesses.push(harness);
    const service = harness.app.service('mcp-servers/test-jwt');

    await expect(
      service.create(
        {
          api_url: `${provider.baseUrl}/jwt`,
          api_token: 'rest-token',
          api_secret: 'rest-secret',
        },
        {
          provider: 'rest',
          user: harness.userA,
          tenant: { tenant_id: 'default', source: 'static' },
        } as AuthenticatedParams
      )
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.create({
        api_url: `${provider.baseUrl}/jwt`,
        api_token: 'internal-token',
        api_secret: 'internal-secret',
      })
    ).resolves.toMatchObject({ success: true });
    expect(provider.requests.filter((entry) => entry.path === '/jwt')).toHaveLength(2);
  });
});

describe('SQLite saved-row OAuth authority', () => {
  it('authenticates REST mutations before the MCP OAuth around hook can read or write', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user', {
      requireAuth: async () => {
        throw new Error('REST authentication rejected before MCP mutation');
      },
    });
    databases.push(harness.rawDb);

    await expect(
      harness.app
        .service('mcp-servers')
        .patch(
          harness.server.mcp_server_id,
          { display_name: 'must-not-commit' },
          { ...paramsFor(harness), provider: 'rest' }
        )
    ).rejects.toThrow('REST authentication rejected before MCP mutation');
    await expect(
      new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id)
    ).resolves.not.toMatchObject({ display_name: 'must-not-commit' });
  });

  it('deletes incompatible durable grants when OAuth subject mode changes', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const grants = new UserMCPOAuthTokenRepository(harness.rawDb);
    await expect(
      grants.getToken(harness.user.user_id as UserID, harness.server.mcp_server_id as MCPServerID)
    ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });

    await harness.app
      .service('mcp-servers')
      .patch(harness.server.mcp_server_id, { auth: { oauth_mode: 'shared' } }, paramsFor(harness));

    await expect(
      grants.getToken(harness.user.user_id as UserID, harness.server.mcp_server_id as MCPServerID)
    ).resolves.toBeNull();
    await expect(
      grants.getToken(null, harness.server.mcp_server_id as MCPServerID)
    ).resolves.toBeNull();
  });

  it('rolls back the MCP server mutation when SQLite grant cleanup fails', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const before = await new MCPServerRepository(harness.rawDb).findById(
      harness.server.mcp_server_id
    );
    const cleanup = vi
      .spyOn(UserMCPOAuthTokenRepository.prototype, 'deleteAllForServer')
      .mockRejectedValueOnce(new Error('injected grant cleanup failure'));
    try {
      await expect(
        harness.app
          .service('mcp-servers')
          .patch(
            harness.server.mcp_server_id,
            { auth: { oauth_mode: 'shared' } },
            paramsFor(harness)
          )
      ).rejects.toThrow('injected grant cleanup failure');
    } finally {
      cleanup.mockRestore();
    }

    await expect(
      new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id)
    ).resolves.toMatchObject({
      config_version: before?.config_version,
      auth: { oauth_mode: 'per_user' },
    });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });
  });

  it('keeps a local pending flow usable when the SQLite mutation rolls back', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      success: boolean;
      authorizationUrl: string;
      attempt_id: string;
    };
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(started.success).toBe(true);
    expect(state).toBeTruthy();

    const cleanup = vi
      .spyOn(UserMCPOAuthTokenRepository.prototype, 'deleteAllForServer')
      .mockRejectedValueOnce(new Error('injected local-flow rollback'));
    try {
      await expect(
        harness.app
          .service('mcp-servers')
          .patch(
            harness.server.mcp_server_id,
            { auth: { oauth_mode: 'shared' } },
            paramsFor(harness)
          )
      ).rejects.toThrow('injected local-flow rollback');
    } finally {
      cleanup.mockRestore();
    }

    await expect(
      harness.app
        .service('mcp-servers/oauth-attempt-status')
        .get(started.attempt_id, paramsFor(harness))
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(harness.callback(state!)).resolves.toMatchObject({ status: 200 });
    await expect(
      new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id)
    ).resolves.toMatchObject({ auth: { oauth_mode: 'per_user' } });
  });

  it('uses the canonical ID for a short-ID mutation with a real grant and local pending flow', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      authorizationUrl: string;
      attempt_id: string;
    };
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const updated = await harness.app
      .service('mcp-servers')
      .patch(
        shortId(harness.server.mcp_server_id),
        { auth: { oauth_scope: 'canonical-short-id' } },
        paramsFor(harness)
      );
    expect(updated).toMatchObject({
      mcp_server_id: harness.server.mcp_server_id,
      auth: { oauth_scope: 'canonical-short-id' },
    });
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toBeNull();
    await expect(
      harness.app
        .service('mcp-servers/oauth-attempt-status')
        .get(started.attempt_id, paramsFor(harness))
    ).resolves.toMatchObject({
      status: 'failed',
      failure_code: 'server_configuration_changed',
      recovery: expect.objectContaining({ category: 'configuration_changed' }),
    });
    await expect(harness.callback(state!)).resolves.toMatchObject({ status: 400 });
  });

  it('rolls back the MCP server mutation when durable pending-flow cleanup fails', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const invalidateForServer = vi.fn(async () => {
      throw new Error('injected pending-flow cleanup failure');
    });
    const harness = await createHarness(provider, 'per_user', {
      durableAuthority: {
        invalidateForServer,
        maintain: vi.fn(),
      } as unknown as NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>,
      lockGrantConfiguration: vi.fn(async () => undefined),
    });
    databases.push(harness.rawDb);
    const before = await new MCPServerRepository(harness.rawDb).findById(
      harness.server.mcp_server_id
    );

    await expect(
      harness.app
        .service('mcp-servers')
        .patch(harness.server.mcp_server_id, { auth: { oauth_mode: 'shared' } }, paramsFor(harness))
    ).rejects.toThrow('injected pending-flow cleanup failure');

    expect(invalidateForServer).toHaveBeenCalledWith('default', harness.server.mcp_server_id);
    await expect(
      new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id)
    ).resolves.toMatchObject({
      config_version: before?.config_version,
      auth: { oauth_mode: 'per_user' },
    });
  });

  it('serializes literal-memory readers across config and grant cleanup', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const originalDeleteAllForServer = UserMCPOAuthTokenRepository.prototype.deleteAllForServer;
    const cleanup = vi
      .spyOn(UserMCPOAuthTokenRepository.prototype, 'deleteAllForServer')
      .mockImplementationOnce(async function (...args) {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        return originalDeleteAllForServer.apply(this, args);
      });
    try {
      const mutation = harness.app
        .service('mcp-servers')
        .patch(
          harness.server.mcp_server_id,
          { auth: { oauth_mode: 'shared' } },
          paramsFor(harness)
        );
      await cleanupStarted.promise;

      let readerFinished = false;
      const observation = Promise.all([
        new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id),
        new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        ),
      ]).finally(() => {
        readerFinished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readerFinished).toBe(false);

      releaseCleanup.resolve();
      await mutation;
      const [server, grant] = await observation;
      expect(server?.auth).toMatchObject({ oauth_mode: 'shared' });
      expect(grant).toBeNull();
    } finally {
      releaseCleanup.resolve();
      cleanup.mockRestore();
    }
  });

  it('does not dispatch test-jwt caller secrets when socket authority changes during DNS', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const dnsStarted = deferred<void>();
    const releaseDns = deferred<void>();
    const outboundDnsLookup: OutboundDnsLookup = async (hostname) => {
      expect(hostname).toBe('localhost');
      dnsStarted.resolve();
      await releaseDns.promise;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const harness = await createHarness(provider, undefined, { outboundDnsLookup });
    databases.push(harness.rawDb);

    const request = harness.app.service('mcp-servers/test-jwt').create(
      {
        api_url: `${provider.baseUrl.replace('127.0.0.1', 'localhost')}/jwt`,
        api_token: 'admin-a-api-token',
        api_secret: 'admin-a-api-secret',
      },
      paramsFor(harness)
    );
    await dnsStarted.promise;
    replaceLiveSocketAuthority(harness, 'b00b');
    releaseDns.resolve();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests.filter((entry) => entry.path === '/jwt')).toEqual([]);
    expect(
      provider.requests.some(
        (entry) =>
          entry.jsonBody?.name === 'admin-a-api-token' ||
          entry.jsonBody?.secret === 'admin-a-api-secret'
      )
    ).toBe(false);
  });

  it('tests JWT credentials normally while keeping provider tokens out of the response', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);

    await expect(
      harness.app.service('mcp-servers/test-jwt').create(
        {
          api_url: `${provider.baseUrl}/jwt`,
          api_token: 'normal-api-token',
          api_secret: 'normal-api-secret',
        },
        paramsFor(harness)
      )
    ).resolves.toEqual({ success: true, tokenValid: true });
    expect(provider.requests.filter((entry) => entry.path === '/jwt')).toEqual([
      expect.objectContaining({
        jsonBody: { name: 'normal-api-token', secret: 'normal-api-secret' },
      }),
    ]);
  });

  it('does not dispatch oauth-start initialize when authority changes during DNS', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const dnsStarted = deferred<void>();
    const releaseDns = deferred<void>();
    const outboundDnsLookup: OutboundDnsLookup = async (hostname) => {
      expect(hostname).toBe('localhost');
      dnsStarted.resolve();
      await releaseDns.promise;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const harness = await createHarness(provider, undefined, { outboundDnsLookup });
    databases.push(harness.rawDb);
    await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
      url: provider.savedMcpUrl.replace('127.0.0.1', 'localhost'),
    });

    const request = harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await dnsStarted.promise;
    replaceLiveSocketAuthority(harness, 'b00f');
    releaseDns.resolve();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests).toEqual([]);
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('returns only closed OAuth start/discovery recovery for hostile network proxies', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const sentinel = 'SENTINEL_OAUTH_HOSTILE_PROXY_219f';
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const hostile = new Proxy(new Error(sentinel), {
      getPrototypeOf() {
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'name' || property === 'code') {
          return { configurable: true, get: getter };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const harness = await createHarness(provider, undefined, {
      outboundDnsLookup: async () => {
        throw hostile;
      },
    });
    databases.push(harness.rawDb);
    await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
      url: provider.savedMcpUrl.replace('127.0.0.1', 'localhost'),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const oauthStart = await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      mcpClientTestState.connectError = hostile;
      const discovery = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(oauthStart).toMatchObject({ success: false, recovery: { category: 'unknown' } });
      expect(discovery).toMatchObject({ success: false, category: 'unknown' });
      expect(JSON.stringify({ oauthStart, discovery, logs: errorSpy.mock.calls })).not.toContain(
        sentinel
      );
      expect(getter).not.toHaveBeenCalled();
      expect(provider.requests).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('abandons oauth-start when its authoritative saved-row read finishes under B', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const rowRead = deferred<void>();
    const releaseRow = deferred<void>();
    const originalFindById = MCPServerRepository.prototype.findById;
    let held = false;
    const findSpy = vi
      .spyOn(MCPServerRepository.prototype, 'findById')
      .mockImplementation(async function (serverId) {
        const row = await originalFindById.call(this, serverId);
        if (!held && serverId === harness.server.mcp_server_id) {
          held = true;
          rowRead.resolve();
          await releaseRow.promise;
        }
        return row;
      });
    try {
      const request = harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      await rowRead.promise;
      replaceLiveSocketAuthority(harness, 'b00c');
      releaseRow.resolve();

      await expect(request).rejects.toThrow(/authority/i);
      expect(provider.requests).toEqual([]);
      expect(harness.emittedBrowserEvents).toEqual([]);
    } finally {
      releaseRow.resolve();
      findSpy.mockRestore();
    }
  });

  it('stops oauth-start after a held initialize probe when the socket becomes B', async () => {
    const provider = await createTestProvider({ holdMcpChallenge: true });
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);

    const request = harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await provider.mcpRequested.promise;
    replaceLiveSocketAuthority(harness, 'b00d');
    provider.releaseMcp();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests.filter((entry) => entry.path.startsWith('/.well-known/'))).toEqual([]);
    expect(provider.requests.filter((entry) => entry.path === '/register')).toEqual([]);
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('does not create an oauth-start pending flow when authority changes during DCR', async () => {
    const provider = await createTestProvider({ holdDynamicRegistration: true });
    providers.push(provider);
    const catalogEntry = {
      name: 'test/oauth-start-held-dcr',
      title: 'Held DCR fixture',
      category: 'developer-tools',
      capabilities: ['testing'],
      benefit: 'Exercises request authority around DCR.',
      starter_prompt: 'Exercise request authority.',
      permission_disclosure: 'Fixture only.',
      popularity_rank: 999_998,
      transport: 'streamable-http',
      remote_url: provider.savedMcpUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
    } as MCPCatalogEntry;
    vi.mocked(loadCatalog)
      .mockResolvedValueOnce([catalogEntry])
      .mockResolvedValueOnce([catalogEntry]);
    const harness = await createHarness(provider, undefined, { catalogEntry });
    databases.push(harness.rawDb);

    const request = harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await provider.dcrRequested.promise;
    replaceLiveSocketAuthority(harness, 'b00e');
    provider.releaseDcr();

    await expect(request).rejects.toThrow(/authority/i);
    expect(provider.requests.filter((entry) => entry.path === '/register')).toHaveLength(1);
    expect(provider.requests.filter((entry) => entry.path === '/token')).toEqual([]);
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

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
        diagnostic?: unknown;
        recovery?: { category?: string; action?: string; redirect_uri?: string };
      };

      expect(result).toMatchObject({
        success: false,
        redirect_uri: 'https://agor.example.test/mcp-servers/oauth-callback',
        recovery: {
          category: 'client_registration_failed',
          action: 'configure_client',
          redirect_uri: 'https://agor.example.test/mcp-servers/oauth-callback',
        },
      });
      expect(result.diagnostic).toBeUndefined();
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
    const { event: browserReservation, expiresAt } = await reserveBrowserEventWithDeadline(
      harness,
      'test-oauth'
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
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
      clock.mockReturnValue(expiresAt);
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
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/authority|reservation/i),
    });
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
    const { event: request, expiresAt } = await reserveBrowserEventWithDeadline(
      harness,
      'discover'
    );
    const before = provider.requests.length;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
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
    const { event: request, expiresAt } = await reserveBrowserEventWithDeadline(
      harness,
      'test-oauth'
    );
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
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
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
      clock.mockReturnValue(expiresAt);
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
      const { event: request, expiresAt } = await reserveBrowserEventWithDeadline(
        harness,
        'discover'
      );
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
        transition === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1) : undefined;
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
          clock!.mockReturnValue(expiresAt);
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
    const { event: request, expiresAt } = await reserveBrowserEventWithDeadline(
      harness,
      'discover'
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
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
      clock.mockReturnValue(expiresAt);
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
    const { event: request, expiresAt } = await reserveBrowserEventWithDeadline(
      harness,
      'discover'
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
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
      clock.mockReturnValue(expiresAt);
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
    // The full daemon suite can take longer than the production TTL under
    // worker contention. Freeze issuance so this quota contract tests its
    // own explicit expiry transition rather than ambient wall-clock speed.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt);

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

    try {
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

      clock.mockReturnValue(issuedAt + 60_001);
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
    // Simulate historical/on-disk drift below the now-closed repository and
    // import contracts. Public and trusted writes can no longer create this
    // inconsistent provenance combination, but grant hydration must remain
    // fail-closed if an older database already contains it.
    await update(harness.rawDb, mcpServers)
      .set({ catalog_entry_name: 'drifted/catalog-stamp' })
      .where(eq(mcpServers.mcp_server_id, harness.server.mcp_server_id))
      .run();

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
