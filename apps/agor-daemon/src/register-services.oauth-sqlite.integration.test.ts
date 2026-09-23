import http, { type Server as HttpServer } from 'node:http';
import { resolveMcpOAuthCallbackOrigin } from '@agor/core/config';
import {
  AppVariableRepository,
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  eq,
  GatewayChannelRepository,
  generateId,
  MCP_SLACK_CONNECT_CARD_KEY,
  MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
  MCPServerRepository,
  MessagesRepository,
  mcpServers,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  setMCPEgressGatewayMode,
  setMCPSlackConnectCardEnabled,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  update,
  userMcpOauthTokens,
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
import {
  AmbiguousRefreshError,
  FailedRefreshError,
  InvalidGrantError,
  OAuthRefreshExchangeError,
} from '@agor/core/tools/mcp/oauth-refresh';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPOAuthBrowserEventRequest,
  MCPOAuthBrowserReservation,
  MCPServer,
  MCPServerID,
  MessageID,
  User,
  UserID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { OutboundDnsLookup } from '@agor/core/utils/safe-outbound-fetch';
import { type Socket as ClientSocket, io as createSocketClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RuntimeJWTStrategy } from './auth/runtime-jwt-strategy.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './auth/runtime-tokens.js';
import {
  type RegisterHooksContext,
  registerHooks,
  TENANT_OWNED_SERVICE_PATHS,
} from './register-hooks.js';
import { createRegisteredMCPCatalogConnectService } from './register-routes.js';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';
import { issueMCPOAuthConnectLink } from './services/mcp-oauth-connect-delivery.js';
import * as oauthUse from './services/mcp-oauth-use.js';
import { createSocketIOConfig } from './setup/socketio.js';
import { issueMCPSlackRecoveryToken } from './utils/mcp-slack-recovery-token.js';
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
  /**
   * What the provider believes it registered, by `client_id`. The fixture
   * keeps this separately from the body it echoes back, because a provider
   * can bind a client to something other than what it reflects — which is
   * exactly why Agor cannot tell locally that its `client_id` is bound to a
   * different redirect URI.
   */
  registeredClients: Map<string, { clientName: string; redirectUris: string[] }>;
  /** Every `/authorize` verdict, in order. `invalid_request` on a mismatch. */
  authorizeVerdicts: Array<{ clientId: string | null; outcome: 'redirect' | 'invalid_request' }>;
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
    gitlab?: boolean;
    malformedRefresh?: boolean;
    rejectDynamicRegistration?: boolean;
    holdDynamicRegistration?: boolean;
    /** Advertise and actually serve `/register`, keeping provider-side state. */
    serveDynamicRegistration?: boolean;
    /**
     * Echo one thing, store another: `/register` reflects the requested
     * `redirect_uris` in its response while binding the client to this value
     * instead. It is invisible to Agor until the front channel refuses.
     */
    registrationStoresRedirectUri?: string;
    resourceScopes?: string[];
    resourcePath?: string;
    metadataIssuer?: string;
    pkceMethods?: readonly string[];
    callbackIssuerSupported?: boolean;
    holdMcpChallenge?: boolean;
    clientCredentialsOnly?: boolean;
  } = {}
): Promise<TestProvider> {
  const requests: TestProvider['requests'] = [];
  let grantRedirectUri: string | null = null;
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
  const registeredClients = new Map<string, { clientName: string; redirectUris: string[] }>();
  const authorizeVerdicts: TestProvider['authorizeVerdicts'] = [];
  let issuedClients = 0;
  const servesRegistration = (): boolean => options.serveDynamicRegistration === true;
  const advertisesRegistration = (): boolean =>
    options.rejectDynamicRegistration === true ||
    options.holdDynamicRegistration === true ||
    servesRegistration();

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

    if (options.clientCredentialsOnly && url.pathname.includes('.well-known')) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          resource: `${baseUrl}${options.resourcePath ?? '/saved/mcp'}`,
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
          issuer: options.metadataIssuer ?? baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          ...(advertisesRegistration() ? { registration_endpoint: `${baseUrl}/register` } : {}),
          response_types_supported: ['code'],
          code_challenge_methods_supported: options.pkceMethods ?? ['S256'],
          // The DCR fixture deliberately omits RFC 9207 response-issuer
          // support. Reaching /register therefore proves that the canonical
          // catalog row selected Marketplace policy rather than strict.
          ...(advertisesRegistration()
            ? {}
            : {
                authorization_response_iss_parameter_supported:
                  options.callbackIssuerSupported ?? true,
              }),
        })
      );
      return;
    }
    if (url.pathname === '/register' && advertisesRegistration()) {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      recordedRequest.jsonBody = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      dcrRequested.resolve();
      if (servesRegistration()) {
        const clientName = String(recordedRequest.jsonBody?.client_name ?? '');
        const requestedRedirectUris = Array.isArray(recordedRequest.jsonBody?.redirect_uris)
          ? (recordedRequest.jsonBody.redirect_uris as string[])
          : [];
        const clientId = `dcr-client-${++issuedClients}`;
        registeredClients.set(clientId, {
          clientName,
          redirectUris: options.registrationStoresRedirectUri
            ? [options.registrationStoresRedirectUri]
            : requestedRedirectUris,
        });
        response.writeHead(201, { 'content-type': 'application/json' });
        // The response echoes the REQUEST, not what the provider stored, so a
        // client bound elsewhere is indistinguishable from a correct one until
        // authorization is attempted.
        response.end(
          JSON.stringify({
            client_id: clientId,
            redirect_uris: requestedRedirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          })
        );
        return;
      }
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
    // The front channel, which no fixture modelled before. A provider checks
    // the authorization request's `redirect_uri` against what it has REGISTERED
    // for the client — not against what it echoed back — and refuses on its own
    // page. It never redirects, so Agor's callback is never reached and Agor
    // has nothing to classify. Tests that only read `state` off the URL step
    // straight over the failure this reproduces.
    if (url.pathname === '/authorize') {
      const clientId = url.searchParams.get('client_id');
      const requested = url.searchParams.get('redirect_uri') ?? '';
      const registered = clientId ? registeredClients.get(clientId) : undefined;
      if (registered && !registered.redirectUris.includes(requested)) {
        authorizeVerdicts.push({ clientId, outcome: 'invalid_request' });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: 'invalid_request',
            error_description: 'Mismatching redirect URI',
          })
        );
        return;
      }
      authorizeVerdicts.push({ clientId, outcome: 'redirect' });
      const location = new URL(requested);
      location.searchParams.set('code', 'authorization-code');
      location.searchParams.set('state', url.searchParams.get('state') ?? '');
      location.searchParams.set('iss', baseUrl);
      response.writeHead(302, { location: location.toString() });
      response.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const isRefresh = new URLSearchParams(body).get('grant_type') === 'refresh_token';
      if (isRefresh) {
        if (options.gitlab) {
          const form = new URLSearchParams(body);
          expect(form.get('redirect_uri')).toBe(grantRedirectUri);
          expect(form.get('client_id')).toBe('saved-client-id');
          expect(form.get('resource')).toBe(`${baseUrl}/saved/mcp`);
          // Omitted scope means the originally granted scope, not an expansion.
          expect(form.has('scope')).toBe(false);
        }
        refreshRequested.resolve();
        if (options.holdRefresh) await releaseRefresh.promise;
        response.writeHead(options.invalidRefresh ? 400 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify(
            options.malformedRefresh
              ? { access_token: 'synthetic-access', refresh_token: 42 }
              : options.invalidRefresh
                ? { error: 'invalid_grant' }
                : {
                    access_token: 'stale-refreshed-access-token',
                    refresh_token: 'stale-rotated-refresh-token',
                    expires_in: options.gitlab ? 7200 : 3600,
                  }
          )
        );
        return;
      }
      grantRedirectUri = new URLSearchParams(body).get('redirect_uri');
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
          expires_in: options.gitlab ? 7200 : 3600,
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
          'www-authenticate': options.clientCredentialsOnly
            ? 'Bearer'
            : `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
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
    registeredClients,
    authorizeVerdicts,
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
  gatewayOAuthResults: Array<{
    taskId: string;
    noticeId: string;
    attemptId: string;
    success: boolean;
  }>;
  /** Widget ids the connect lane asked the gateway to repaint. */
  syncedConnectCards: string[];
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
    withoutClient?: boolean;
    catalogEntry?: MCPCatalogEntry;
    durableAuthority?: NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>;
    durableClientRegistrationAuthority?: NonNullable<
      RegisterServicesContext['mcpOAuthClientRegistrationAuthority']
    >;
    lockGrantConfiguration?: NonNullable<RegisterServicesContext['lockMcpOAuthGrantConfiguration']>;
    outboundDnsLookup?: OutboundDnsLookup;
    requireAuth?: RegisterServicesContext['requireAuth'];
    deployment?: RegisterServicesContext['deployment'];
    /**
     * Arm the daemon's tenant database scope guard for this harness.
     *
     * **On by default**, which is what the production daemon does
     * (`setup/database.ts` takes the `requireScope` default in every mode). A
     * harness that opts out gets a `:memory:` SQLite handle with no guard, so
     * a repository read performed outside a tenant scope silently succeeds —
     * and that is precisely the arrangement in which six scope defects have
     * now shipped, none of them visible to a test.
     *
     * It was off by default until the sixth instance, which the default itself
     * found: turning it on turned 11 assertions red on the standalone token
     * refresh, which was reading through the raw handle. That is fixed; the
     * default stays on so the seventh has nowhere to hide.
     *
     * `false` is available for a fixture that still reaches the database
     * through a path that does not open a scope, but it is a statement about
     * that fixture, not about production.
     */
    requireTenantScope?: boolean;
    /**
     * Make the gateway's connect-card repaint never answer.
     *
     * Every other stub in this file resolves immediately, which is why no
     * fixture here could express a HANG — and a hang is what one stalled
     * `chat.update` inside `syncMcpSlackConnectCard` actually is. The
     * `oauth-start` handler used to await that repaint inside its own failure
     * handler, ahead of the only line that logs what went wrong.
     */
    stallConnectCardSync?: boolean;
  } = {}
) {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = (options.requireTenantScope === false
    ? rawDb
    : createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'sqlite oauth harness',
      })) as unknown as TenantScopeAwareDatabase;
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
      ...(catalogEntry || options.withoutClient ? {} : { oauth_client_id: 'saved-client-id' }),
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
  const gatewayOAuthResults: SQLiteHarness['gatewayOAuthResults'] = [];
  const syncedConnectCards: string[] = [];
  app.use(
    '/gateway',
    {
      async syncMcpSlackRecoveryNoticeAfterCommit() {},
      async syncMcpSlackConnectCard(widgetId: string) {
        syncedConnectCards.push(widgetId);
        if (options.stallConnectCardSync) await new Promise<void>(() => {});
      },
      async markMcpSlackOAuthResult(input: SQLiteHarness['gatewayOAuthResults'][number]) {
        gatewayOAuthResults.push(input);
      },
    },
    {
      methods: [
        'syncMcpSlackRecoveryNoticeAfterCommit',
        'syncMcpSlackConnectCard',
        'markMcpSlackOAuthResult',
      ],
    }
  );
  const deployment = options.deployment ?? ({} as RegisterServicesContext['deployment']);
  const callbackOrigin = resolveMcpOAuthCallbackOrigin({}, process.env);
  const mcpOAuthCallbackUrl =
    deployment.mode === 'ha'
      ? (callbackOrigin.haCallbackUrl ?? undefined)
      : (callbackOrigin.standaloneCallbackUrl ?? undefined);
  const { oauthCallbackHandler } = await registerMCPServices({
    db,
    app,
    config: {} as RegisterServicesContext['config'],
    jwtSecret: 'test-jwt',
    daemonUrl: 'http://127.0.0.1:3030',
    bundledUiAvailable: false,
    DAEMON_PORT: 3030,
    UI_PORT: 5173,
    allowSuperadmin: false,
    requireAuth: options.requireAuth ?? (async (context) => context),
    deployment,
    mcpOAuthCallbackUrl,
    mcpOAuthPendingFlowAuthority: options.durableAuthority,
    mcpOAuthClientRegistrationAuthority: options.durableClientRegistrationAuthority,
    lockMcpOAuthGrantConfiguration: options.lockGrantConfiguration,
    mcpOutboundDnsLookup: options.outboundDnsLookup,
  });
  // Tenant-owned services arm their database scope from an around-hook that
  // `registerHooks` installs, and this service-only harness does not run that
  // chain. Install the same scope for the tenant-owned services it stands up,
  // so a nested `app.service('mcp-servers').create(...)` sees in the harness
  // exactly what it sees in the daemon. Without this the guard would report a
  // missing hook as if it were a missing scope in the code under test.
  for (const path of TENANT_OWNED_SERVICE_PATHS) {
    let service: { hooks(options: unknown): void } | undefined;
    try {
      service = app.service(path) as unknown as { hooks(options: unknown): void };
    } catch {
      continue;
    }
    service?.hooks({
      around: {
        all: [
          async (_context: unknown, next: () => Promise<void>) =>
            runWithTenantDatabaseScope(db, 'default', next),
        ],
      },
    });
  }

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
    gatewayOAuthResults,
    syncedConnectCards,
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

const constrainedHaDeployment = {
  mode: 'ha',
  supportProfile: 'constrained-active-active',
  capabilities: {
    taskExecution: true,
    executorTokenAuthority: true,
    agorManagedInteractivePermissions: true,
    scheduler: true,
    sessionQueue: true,
    taskRuntimeReconciliation: true,
    knowledgeEmbeddingIndexer: true,
    statelessMcp: true,
    mcpOAuth: true,
    completionCallbackDurableAdmission: true,
    completionCallbackPreAdmissionRecovery: false,
    widgetResolutionDurableClaim: true,
    githubInstall: true,
    codexCredentialFiles: false,
    codexDeviceAuth: false,
    processAffineAuth: false,
    gatewayListeners: true,
    gatewayOutboundExactlyOnce: false,
    environmentHealthMonitor: true,
    artifactRuntimeIntrospection: false,
  },
  redis: {},
  environmentHealthMonitor: {},
  executorStorage: {
    userHome: 'replica-local',
    branchWorkspace: 'shared',
    baseRepository: 'shared',
  },
  topology: {
    execution: 'shared-local',
    sharedFilesystem: true,
    ingressAffinity: true,
  },
  mcpOAuthCallbackUrl: 'https://agor.example.test/mcp-servers/oauth-callback',
} as RegisterHooksContext['deployment'];

/**
 * Install the same hook registrar used by daemon boot while letting this MCP-
 * focused harness stand in empty services for unrelated product surfaces.
 */
function registerProductionHooksForHarness(harness: SQLiteHarness): void {
  const emptyService = { hooks() {}, on() {}, emit() {} };
  const registrationApp = {
    service(path: string) {
      try {
        return harness.app.service(path);
      } catch {
        return emptyService;
      }
    },
    use() {},
    publish() {},
    emit() {},
  } as unknown as RegisterHooksContext['app'];

  registerHooks({
    db: harness.db,
    app: registrationApp,
    config: {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'default' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'ha-discovery-registration-test',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: false },
    sessionsService: emptyService as RegisterHooksContext['sessionsService'],
    messagesService: emptyService as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    deployment: constrainedHaDeployment,
  });
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

async function seedSlackRecoveryAction(harness: SQLiteHarness): Promise<{
  token: string;
  taskId: string;
  sessionId: string;
}> {
  const repo = await new RepoRepository(harness.rawDb).create({
    repo_id: generateId(),
    slug: `slack-recovery-${generateId()}`,
    name: 'Slack recovery integration',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/slack-recovery.git',
    local_path: `/tmp/slack-recovery-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(harness.rawDb).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: `slack-recovery-${generateId()}`,
    ref: 'main',
    branch_unique_id: 100_000 + Math.floor(Math.random() * 1_000_000_000),
    path: `/tmp/slack-recovery-${generateId()}/branch`,
    created_by: harness.user.user_id,
  });
  const session = await new SessionRepository(harness.rawDb).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    created_by: harness.user.user_id,
    sdk_session_id: 'sdk-session-preserved',
  });
  await new SessionMCPServerRepository(harness.rawDb).addServer(
    session.session_id,
    harness.server.mcp_server_id
  );
  const channel = await new GatewayChannelRepository(harness.rawDb).create({
    name: 'Slack recovery',
    channel_type: 'slack',
    enabled: true,
    created_by: harness.user.user_id,
    agor_user_id: harness.user.user_id,
    target_branch_id: branch.branch_id,
    config: { bot_token: 'xoxb-test-only', app_token: 'xapp-test-only' },
  });
  const threadId = 'C2515-1756200000.000001';
  await new ThreadSessionMapRepository(harness.rawDb).create({
    channel_id: channel.id,
    thread_id: threadId,
    session_id: session.session_id,
    branch_id: branch.branch_id,
  });
  await setMCPEgressGatewayMode(harness.rawDb, 'compatibility', harness.user.user_id);

  const issued = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const expires = new Date(issued.getTime() + 10 * 60_000);
  const taskId = generateId();
  const noticeId = generateId();
  const jti = generateId();
  const requestId = generateId();
  const generation = 7;
  const task = await new TaskRepository(harness.rawDb).create({
    task_id: taskId,
    session_id: session.session_id,
    created_by: harness.user.user_id,
    full_prompt: 'recover MCP in this same Slack Task',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: issued.toISOString(),
    },
    git_state: { ref_at_start: 'main', sha_at_start: 'slack-recovery' },
    metadata: {
      gateway_task_source: {
        gateway_channel_id: channel.id,
        channel_type: 'slack',
        thread_id: threadId,
        provider_user_id: 'U2515',
        slack_team_id: 'T2515',
        slack_channel_id: 'C2515',
      },
      mcp_recovery_generation: generation,
      mcp_recovery: {
        generation,
        code: 'oauth_reauth_required',
        status: 'action_required',
        task_id: taskId,
        session_id: session.session_id,
        mcp_server_id: harness.server.mcp_server_id,
        provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
        action: 'reauthenticate',
        message: 'MCP sign-in required',
        observed_at: issued.toISOString(),
        request_id: requestId,
        provider_dispatch: 'not_started',
      },
      mcp_slack_recovery_notice: {
        notice_id: noticeId,
        token_jti: jti,
        issued_at: issued.toISOString(),
        expires_at: expires.toISOString(),
        principal_user_id: harness.user.user_id,
        credential_user_id: harness.user.user_id,
        slack_user_id: 'U2515',
        slack_team_id: 'T2515',
        gateway_channel_id: channel.id,
        gateway_config_generation: channel.provider_config_generation,
        slack_channel_id: 'C2515',
        slack_thread_id: threadId,
        session_id: session.session_id,
        task_id: taskId,
        mcp_server_id: harness.server.mcp_server_id,
        mcp_server_config_version: harness.server.config_version ?? 1,
        recovery_generation: generation,
        recovery_request_id: requestId,
        provider_dispatch: 'not_started',
        delivery_id: generateId(),
        next_repair_at: issued.toISOString(),
      },
    },
  });
  expect(task.task_id).toBe(taskId);
  const token = issueMCPSlackRecoveryToken(
    {
      type: 'mcp-slack-recovery',
      tid: 'default',
      sub: harness.user.user_id,
      credential_user_id: harness.user.user_id,
      slack_user_id: 'U2515',
      slack_team_id: 'T2515',
      gateway_channel_id: channel.id,
      gateway_config_generation: channel.provider_config_generation,
      slack_channel_id: 'C2515',
      slack_thread_id: threadId,
      task_id: taskId,
      session_id: session.session_id,
      mcp_server_id: harness.server.mcp_server_id,
      mcp_server_config_version: harness.server.config_version ?? 1,
      recovery_generation: generation,
      recovery_request_id: requestId,
      notice_id: noticeId,
      jti,
      expiresAt: expires,
    },
    process.env.AGOR_MASTER_SECRET!,
    issued
  );
  return { token, taskId, sessionId: session.session_id };
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
    allowSuperadmin: false,
    requireAuth: async (context) => {
      if (context.params.provider === 'socketio' && !context.params.user) {
        throw new Error('Unauthenticated Socket.IO integration request');
      }
      context.params.tenant = { tenant_id: 'default', source: 'static' };
      return context;
    },
    deployment: {} as RegisterServicesContext['deployment'],
    mcpOAuthCallbackUrl:
      resolveMcpOAuthCallbackOrigin({}, process.env).standaloneCallbackUrl ?? undefined,
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

/**
 * Both Slack MCP lanes, always with the daemon's tenant database scope guard.
 *
 * Mandatory rather than opt-in. Five tenant-scope defects have now reached a
 * running daemon on these two lanes, every one of them invisible to a fixture
 * that lets an unscoped read succeed — and the option below is exactly the
 * kind of thing a new test forgets to pass. A lane whose fixtures cannot be
 * built without the guard cannot regrow that gap.
 */
async function createSlackLaneHarness(
  provider: TestProvider,
  options: Omit<Parameters<typeof createHarness>[2], 'requireTenantScope'> = {}
) {
  return createHarness(provider, undefined, { ...options, requireTenantScope: true });
}

describe('Slack MCP recovery authenticated route', () => {
  it('preflights, consumes once, and propagates the exact reserved OAuth attempt', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedSlackRecoveryAction(harness);
    const params = paramsFor(harness);

    const preflight = (await harness.app
      .service('mcp-slack-recovery')
      .create({ token: seeded.token }, params)) as { state: string; return_to_slack_url: string };
    expect(preflight).toMatchObject({ state: 'reconnect_required' });
    expect(preflight.return_to_slack_url).toContain('team=T2515');

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ slack_recovery_token: seeded.token }, params)) as {
      success: boolean;
      attempt_id: string;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    expect(new URL(started.authorizationUrl).searchParams.get('state')).toBeTruthy();

    const task = await new TaskRepository(harness.rawDb).findById(seeded.taskId);
    expect(task?.metadata?.mcp_slack_recovery_notice).toMatchObject({
      token_consumed_at: expect.any(String),
      oauth_attempt_id: started.attempt_id,
      oauth_started_at: expect.any(String),
    });
    expect(task?.metadata?.mcp_slack_recovery_notice?.oauth_start_claim_expires_at).toBeUndefined();
    expect(
      (await new SessionRepository(harness.rawDb).findById(seeded.sessionId))?.sdk_session_id
    ).toBe('sdk-session-preserved');

    const duplicate = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ slack_recovery_token: seeded.token }, params)) as { success: boolean };
    expect(duplicate.success).toBe(false);

    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    expect((await harness.callback(state!)).status).toBe(200);
    expect(harness.gatewayOAuthResults).toContainEqual({
      taskId: seeded.taskId,
      noticeId: task?.metadata?.mcp_slack_recovery_notice?.notice_id,
      attemptId: started.attempt_id,
      success: true,
    });
    expect(
      (await new SessionRepository(harness.rawDb).findById(seeded.sessionId))?.sdk_session_id
    ).toBe('sdk-session-preserved');
  });

  /**
   * The recovery lane's own start lease, with the guard armed.
   *
   * It carries the identical defect the connect lane was blocked for — its
   * lease renewal, failure marker, and `oauth_started_at` stamp all touch the
   * Task repository outside any scope — and this file's other recovery tests
   * could not see it, because they run without the guard.
   */
  it('starts a recovery sign-in with the tenant scope guard armed', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedSlackRecoveryAction(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ slack_recovery_token: seeded.token }, paramsFor(harness))) as {
      success: boolean;
      attempt_id?: string;
    };

    expect(started).toMatchObject({ success: true });
    expect(provider.requests.length).toBeGreaterThan(0);
    const task = await new TaskRepository(harness.rawDb).findById(seeded.taskId);
    expect(task?.metadata?.mcp_slack_recovery_notice).toMatchObject({
      token_consumed_at: expect.any(String),
      oauth_attempt_id: started.attempt_id,
      oauth_started_at: expect.any(String),
    });
  });

  it('fails closed after preflight when the Agor principal is revoked', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedSlackRecoveryAction(harness);
    const params = paramsFor(harness);

    await harness.app.service('mcp-slack-recovery').create({ token: seeded.token }, params);
    await new UsersRepository(harness.rawDb).update(harness.user.user_id, { role: 'viewer' });
    const revoked = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ slack_recovery_token: seeded.token }, params)) as { success: boolean };
    expect(revoked.success).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  it('projects provider success as superseded when authority changes during exchange', async () => {
    const provider = await createTestProvider({ holdToken: true });
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedSlackRecoveryAction(harness);
    const params = paramsFor(harness);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ slack_recovery_token: seeded.token }, params)) as {
      success: boolean;
      attempt_id: string;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = harness.callback(state!);
    await provider.tokenRequested.promise;
    await new UsersRepository(harness.rawDb).update(harness.user.user_id, { role: 'viewer' });
    provider.releaseToken();

    expect((await callback).status).toBe(409);
    expect(harness.gatewayOAuthResults).toContainEqual({
      taskId: seeded.taskId,
      noticeId: expect.any(String),
      attemptId: started.attempt_id,
      success: true,
    });
  });
});
/**
 * The connect lane's browser preflight, with the daemon's tenant database
 * scope guard armed.
 *
 * `/mcp-oauth-connect` is registered outside `TENANT_OWNED_SERVICE_PATHS`, so
 * nothing upstream opens a tenant database scope for it: the service has to
 * open its own. A harness without the guard cannot see that — a `:memory:`
 * SQLite database answers an unscoped read happily — which is exactly how the
 * missing scope reached a running daemon, where every valid link came back as
 * the lane's generic `Forbidden`.
 */
describe('Slack MCP connect authenticated route', () => {
  async function seedConnect(harness: SQLiteHarness, options: { ageMs?: number } = {}) {
    const repo = await new RepoRepository(harness.rawDb).create({
      slug: `slack-connect-${generateId()}`,
      name: 'Slack connect repo',
      repo_type: 'local',
      local_path: `/tmp/slack-connect-${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(harness.rawDb).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `slack-connect-${generateId()}`,
      ref: 'main',
      branch_unique_id: 100_000 + Math.floor(Math.random() * 1_000_000_000),
      path: `/tmp/slack-connect-${generateId()}/branch`,
      created_by: harness.user.user_id,
    });
    const session = await new SessionRepository(harness.rawDb).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: harness.user.user_id,
    });
    const channel = await new GatewayChannelRepository(harness.rawDb).create({
      name: 'Slack connect',
      channel_type: 'slack',
      enabled: true,
      created_by: harness.user.user_id,
      agor_user_id: harness.user.user_id,
      target_branch_id: branch.branch_id,
      // Alignment on: without it the lane refuses at issue, so a test that
      // left it off would prove nothing about the scope.
      config: { align_slack_users: true, bot_token: 'xoxb-test-only', app_token: 'xapp-test-only' },
    });
    const threadId = 'C2515-1756200000.000002';
    await new ThreadSessionMapRepository(harness.rawDb).create({
      channel_id: channel.id,
      thread_id: threadId,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    });
    const taskId = generateId();
    await new TaskRepository(harness.rawDb).create({
      task_id: taskId,
      session_id: session.session_id,
      created_by: harness.user.user_id,
      full_prompt: 'connect me to this MCP server',
      status: TaskStatus.COMPLETED,
      message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
      git_state: { ref_at_start: 'main', sha_at_start: 'slack-connect' },
      tool_use_count: 0,
      metadata: {
        gateway_task_source: {
          gateway_channel_id: channel.id,
          channel_type: 'slack',
          thread_id: threadId,
          provider_user_id: 'U2515',
          slack_team_id: 'T2515',
          slack_channel_id: 'C2515',
        },
      },
    });
    const widgetId = generateId();
    const messages = new MessagesRepository(harness.rawDb);
    await messages.create({
      message_id: widgetId,
      session_id: session.session_id,
      task_id: taskId,
      type: 'widget_request',
      role: 'system',
      index: 0,
      timestamp: new Date().toISOString(),
      content: 'Connect this server',
      content_preview: 'Widget: oauth',
      metadata: {
        widget: {
          widget_type: 'oauth',
          widget_id: widgetId,
          schema_version: 1,
          status: 'pending',
          requested_at: new Date().toISOString(),
          auto_resume: true,
          params: {
            mcpServerId: harness.server.mcp_server_id,
            serverName: 'Saved OAuth server',
            oauthMode: 'per_user',
            reason: 'Read the roadmap page.',
            permissionDisclosure: 'Agor will read the pages you share with it.',
          },
        },
      },
    });
    const issued = await issueMCPOAuthConnectLink(
      {
        repositories: {
          sessions: new SessionRepository(harness.rawDb),
          users: new UsersRepository(harness.rawDb),
          channels: new GatewayChannelRepository(harness.rawDb),
          servers: new MCPServerRepository(harness.rawDb),
          threadMap: new ThreadSessionMapRepository(harness.rawDb),
        },
        messages,
        tasks: new TaskRepository(harness.rawDb),
        masterSecret: process.env.AGOR_MASTER_SECRET!,
        baseUrl: 'https://agor.example.test',
      },
      {
        tenantId: 'default',
        widgetId,
        now: new Date(Date.now() - (options.ageMs ?? 0)),
      }
    );
    if (!issued) throw new Error('Expected a connect link');
    return {
      widgetId,
      channelId: channel.id,
      token: decodeURIComponent(issued.url.split('#token=')[1]),
      widgetStatus: async () =>
        (await messages.findById(widgetId))?.metadata?.widget?.status ?? 'missing',
      delivery: async () => (await messages.findById(widgetId))?.metadata?.widget?.slack_connect,
    };
  }

  it('preflights a live link for the user it was issued to', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const preflight = await harness.app
      .service('mcp-oauth-connect')
      .create({ token: seeded.token }, paramsFor(harness));

    expect(preflight).toMatchObject({
      state: 'connect_required',
      widget_id: seeded.widgetId,
      server_name: 'Saved OAuth server',
      oauth_mode: 'per_user',
      reason: 'Read the roadmap page.',
      permission_disclosure: 'Agor will read the pages you share with it.',
    });
    expect(preflight.return_to_slack_url).toContain('team=T2515');
    // A preflight reads; it never consumes.
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  /**
   * B1 — what the page is told when the sign-in already succeeded.
   *
   * The provider callback persists the grant and nothing else: the widget's
   * resolution and the agent's wake-up wait on the browser's POST. This
   * preflight used to map that straight onto `connected`, which is the one
   * answer that makes a stuck request look finished.
   */
  it('preflights a grant that already landed as a finish, not as a connection', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    await new UserMCPOAuthTokenRepository(harness.rawDb).saveToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID,
      {
        accessToken: 'landed-access-token',
        refreshToken: 'landed-refresh-token',
        clientId: 'saved-client-id',
        expiresAt: new Date(Date.now() + 3_600_000),
      }
    );

    const preflight = (await harness.app
      .service('mcp-oauth-connect')
      .create({ token: seeded.token }, paramsFor(harness))) as { state: string };

    expect(preflight).toMatchObject({ state: 'finish_required' });
    // Still a read: the recovery is a separate, authenticated POST.
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  /**
   * The same finish, withheld — because the resolver would refuse it.
   *
   * Everything the finish branch needs is present: a grant on file, a live
   * link, an unresolved widget, and a claim old enough for `submissions.ts` to
   * take over. The one thing that differs is what the claim is FOR. The user
   * tapped "Not now", the resolver died holding a `dismiss` claim, and the
   * reclaim gate admits an abandoned claim only for its own action — so the
   * `oauth_callback` this page's button posts comes back "already resolving;
   * cannot oauth_callback again". Reading the claim's age and not its action
   * made the page offer exactly that.
   */
  it('preflights an abandoned dismissal as pending, not as a finish it would refuse', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    await new UserMCPOAuthTokenRepository(harness.rawDb).saveToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID,
      {
        accessToken: 'landed-access-token',
        refreshToken: 'landed-refresh-token',
        clientId: 'saved-client-id',
        expiresAt: new Date(Date.now() + 3_600_000),
      }
    );
    const messages = new MessagesRepository(harness.rawDb);
    await messages.mutateMetadataLocked(seeded.widgetId as MessageID, (metadata) => ({
      ...metadata,
      widget: {
        ...metadata!.widget!,
        status: 'resolving',
        resolution_claim: {
          token: 'claim-from-a-dead-dismissal',
          action: 'dismiss',
          claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          claimed_by: harness.user.user_id as UserID,
        },
      },
    }));

    const preflight = (await harness.app
      .service('mcp-oauth-connect')
      .create({ token: seeded.token }, paramsFor(harness))) as { state: string };

    expect(preflight).toMatchObject({ state: 'sign_in_pending' });
    // Still a read, and the claim is still whoever's it was.
    expect(await seeded.widgetStatus()).toBe('resolving');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  it('describes a request that already finished instead of calling the link invalid', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    const messages = new MessagesRepository(harness.rawDb);
    await messages.mutateMetadataLocked(seeded.widgetId as MessageID, (metadata) => ({
      ...metadata,
      widget: {
        ...metadata!.widget!,
        status: 'submitted',
        resolved_at: new Date().toISOString(),
        result_meta: { attached: true },
      },
    }));

    const preflight = (await harness.app
      .service('mcp-oauth-connect')
      .create({ token: seeded.token }, paramsFor(harness))) as { state: string };

    // Describing it grants nothing — `oauth-start` still refuses a widget that
    // is no longer pending, and the consume CAS re-checks it under the row
    // lock — but telling the person who just finished that their link is
    // "invalid, expired, or superseded" is the opposite of what happened.
    expect(preflight).toMatchObject({ state: 'connected' });
    await expect(
      harness.app
        .service('mcp-servers/oauth-start')
        .create({ connect_token: seeded.token }, paramsFor(harness))
    ).resolves.toMatchObject({ success: false });
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  it.each([
    [
      'a signed-in user who is not the claims subject',
      async (harness: SQLiteHarness, token: string) => {
        const other = await new UsersRepository(harness.rawDb).create({
          email: `slack-connect-other-${generateId()}@example.test`,
          role: 'admin',
        });
        return {
          token,
          params: { ...paramsFor(harness), user: other } as AuthenticatedParams,
        };
      },
    ],
    [
      'a tampered token',
      async (harness: SQLiteHarness, token: string) => ({
        token: `${token.slice(0, -5)}AAAAA`,
        params: paramsFor(harness),
      }),
    ],
  ])('refuses %s and leaves the widget pending', async (_name, mutate) => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    const attempt = await mutate(harness, seeded.token);

    await expect(
      harness.app.service('mcp-oauth-connect').create({ token: attempt.token }, attempt.params)
    ).rejects.toMatchObject({
      code: 403,
      message: 'This MCP connect action is invalid, expired, or superseded.',
    });
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  /**
   * The kill switch has to stop the lane from GRANTING, not just from
   * repainting: a card already in a thread carries a live sealed link, and an
   * operator turning the projection off during an incident is asking for that
   * link to stop working. The canvas widget stays live either way — it is the
   * fallback the switch leaves behind.
   */
  it('refuses a live link once the Slack card projection is switched off', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    await setMCPSlackConnectCardEnabled(harness.rawDb, false, harness.user.user_id);

    await expect(
      harness.app.service('mcp-oauth-connect').create({ token: seeded.token }, paramsFor(harness))
    ).rejects.toMatchObject({
      code: 403,
      message: 'This MCP connect action is invalid, expired, or superseded.',
    });
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as { success: boolean };
    expect(started.success).toBe(false);
    // Nothing was consumed, so turning the switch back on restores the link
    // rather than leaving a burned one behind.
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();

    await setMCPSlackConnectCardEnabled(harness.rawDb, true, harness.user.user_id);
    await expect(
      harness.app.service('mcp-oauth-connect').create({ token: seeded.token }, paramsFor(harness))
    ).resolves.toMatchObject({ state: 'connect_required' });

    // Deliberately not fail-closed on a value nobody recognises: a mistyped
    // setting must not silently retire an affordance a thread is showing.
    await new AppVariableRepository(harness.rawDb).set({
      namespace: MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
      key: MCP_SLACK_CONNECT_CARD_KEY,
      value: 'disbaled',
      content_type: 'text/plain',
    });
    await expect(
      harness.app.service('mcp-oauth-connect').create({ token: seeded.token }, paramsFor(harness))
    ).resolves.toMatchObject({ state: 'connect_required' });
  });

  it('refuses an expired link and leaves the widget pending', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    // Minted a minute past its own maximum lifetime: the sealed claims and the
    // stored delivery still agree, so expiry is the only thing left to refuse.
    const seeded = await seedConnect(harness, { ageMs: 11 * 60_000 });

    await expect(
      harness.app.service('mcp-oauth-connect').create({ token: seeded.token }, paramsFor(harness))
    ).rejects.toMatchObject({ code: 403 });
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  /**
   * The lane's durable touches AFTER the binding loader's own scope has closed.
   *
   * `loadMCPOAuthConnectBinding` opens and closes one scope of its own, so a
   * suite that only exercises the preflight proves nothing about the rest of
   * `oauth-start`: the start lease, its 10s renewal timer, the failure marker,
   * and the `oauth_started_at` stamp all run after that scope is gone, on a
   * path nothing upstream arms. Unscoped, the lease renewal throws
   * `MissingTenantDatabaseScope`, the handler reports `success: false` before
   * it has spoken to the provider at all, and the failure marker — which is
   * also unscoped — swallows its own throw, leaving a consumed one-use token
   * with no `oauth_failed_at` for the card to render.
   */
  it('starts the provider flow for a live link, with the scope guard armed', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as {
      success: boolean;
      attempt_id?: string;
      error?: string;
      authorizationUrl?: string;
    };

    expect(started).toMatchObject({ success: true });
    expect(new URL(started.authorizationUrl!).searchParams.get('state')).toBeTruthy();
    // The provider was actually reached: a scope failure returns before the
    // first outbound request, which is what made the symptom look like a
    // refusal rather than a missing unit of work.
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(await seeded.delivery()).toMatchObject({
      token_consumed_at: expect.any(String),
      oauth_attempt_id: started.attempt_id,
      oauth_started_at: expect.any(String),
    });
    expect((await seeded.delivery())?.oauth_start_claim_expires_at).toBeUndefined();
    expect(await seeded.widgetStatus()).toBe('pending');
  });

  /**
   * The same failure handler, reached on purpose.
   *
   * The binding still loads and the one-use token is still consumed; what
   * fails is provider discovery, which is exactly the window the failure
   * marker exists for. That marker is the only thing standing between a burned
   * one-use link and a card that can say so, and unscoped it threw into a
   * `.catch()` that dropped the result — so the link was gone and the card
   * kept offering it.
   */
  /**
   * F2 — what `oauth-start` tells a user whose link was refused.
   *
   * The binding loader collapses every refusal into one generic `Forbidden`
   * so a redeemer cannot learn which binding moved. Classified as a bare
   * `Forbidden`, that became "the MCP request authority ... changed or
   * expired" — a claim about the user's ACCESS, made on the strength of a
   * signature that did not verify. Whoever read it went to check permissions
   * that were fine, and never got told the one thing that would have helped.
   */
  it('reports a tampered link as a spent link, not as changed authority', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: `${seeded.token}tampered` }, paramsFor(harness))) as {
      success: boolean;
      error?: string;
      recovery?: { category?: string; action?: string; message?: string };
    };

    expect(started.success).toBe(false);
    expect(started.recovery).toMatchObject({
      category: 'link_not_admitted',
      action: 'request_new_link',
    });
    expect(started.error).toContain('new link');
    expect(started.error).not.toContain('authority');
    // Still silent about WHICH binding refused: the copy is the same sentence
    // for a forged signature as for an expired one.
    expect(started.error).not.toContain('signature');
    // And nothing was spent proving it — the real link still works.
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.token_consumed_at).toBeUndefined();
  });

  it('marks a consumed link failed when the start cannot proceed', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    // Take the provider away without touching the server row, whose
    // `config_version` the sealed claims pin.
    await provider.close();

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as { success: boolean };

    expect(started.success).toBe(false);
    // The user's one-shot link is gone; the record has to say why, or the card
    // keeps offering a button that can never work again.
    expect(await seeded.delivery()).toMatchObject({
      token_consumed_at: expect.any(String),
      oauth_failed_at: expect.any(String),
    });
    expect((await seeded.delivery())?.oauth_start_claim_expires_at).toBeUndefined();
    // Recording it is not enough — the card in the thread is the only surface
    // the user has, and nothing else wakes it until the repair sweep. The
    // nudge is dispatched but deliberately not awaited (a stalled Slack write
    // must not hang the start), so this waits for it rather than assuming the
    // handler's own awaits happened to flush it.
    await vi.waitFor(() => expect(harness.syncedConnectCards).toContain(seeded.widgetId));
  });

  /**
   * A failing start must account for itself even when Slack does not answer.
   *
   * `oauth-start`'s outer catch ran the repaint FIRST, and the repaint ends in
   * a Slack call. One stalled `chat.update` therefore hung the handler ahead
   * of `externalFailure` — the only line that says what went wrong — so a
   * start that failed for a perfectly classifiable reason produced no URL, no
   * error and no category at all, and the request never settled.
   *
   * The divergence was ours rather than Slack's: the canvas path returns early
   * at `if (!binding) return` and can never reach the Slack call, and the
   * recovery lane has always dispatched its repaint fire-and-forget. Only the
   * connect lane awaited it.
   *
   * Both halves of the fix are asserted here, because either one alone still
   * leaves a user with a thirty-second-a-card read: the classified line lands
   * even while the repaint is stalled, AND the request settles anyway.
   */
  it('classifies, logs and settles a failing start while the card repaint is stalled', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider, { stallConnectCardSync: true });
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);
    // Same failure as the test above: the provider is gone, so the start has
    // something real and classifiable to report.
    await provider.close();

    const logged: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    let started: { success: boolean; recovery?: { category?: string } };
    try {
      started = (await Promise.race([
        harness.app
          .service('mcp-servers/oauth-start')
          .create({ connect_token: seeded.token }, paramsFor(harness)),
        // Comfortably under the suite's own 10s timeout, so a regression
        // fails by this name rather than as an anonymous test timeout.
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('oauth-start never settled while the repaint was stalled')),
            5_000
          ).unref?.()
        ),
      ])) as typeof started;
    } finally {
      errorSpy.mockRestore();
    }

    expect(started.success).toBe(false);
    expect(started.recovery?.category).toBeTruthy();
    // The classified line is the whole point: it has to be on disk BEFORE
    // anything durable or outbound is attempted, so the next occurrence is a
    // one-line read regardless of what Slack is doing.
    expect(logged.some((line) => line.includes('[OAuth Start] event=mcp_external_failure'))).toBe(
      true
    );
    // The durable record is still written — the repaint is what was dropped
    // from the request path, not the accounting.
    expect(await seeded.delivery()).toMatchObject({ oauth_failed_at: expect.any(String) });
    // And the repaint was still DISPATCHED; it is simply nobody's business to
    // wait for it. `next_repair_at` hands the card to the sweep either way.
    expect(harness.syncedConnectCards).toContain(seeded.widgetId);
    expect((await seeded.delivery())?.next_repair_at).toEqual(expect.any(String));
  });

  /**
   * The callback must refuse a flow the channel has since revoked.
   *
   * The sealed link pins `gateway_config_generation`, and rotating the bot
   * token moves it — that is the whole point of the pin. Re-reading the
   * channel at callback time and passing its CURRENT generation as the
   * expected one compares the channel to itself and can never refuse, so an
   * obsolete flow completed and persisted a grant. The expected generation has
   * to be the one that authorized this flow.
   */
  it('refuses a callback whose gateway configuration generation was revoked', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as {
      success: boolean;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const channels = new GatewayChannelRepository(harness.rawDb);
    const before = await channels.findById(seeded.channelId);
    await channels.update(seeded.channelId, {
      config: { ...before?.config, bot_token: 'xoxb-rotated-after-issue' },
    });
    expect((await channels.findById(seeded.channelId))?.provider_config_generation).toBe(
      (before?.provider_config_generation ?? 0) + 1
    );

    expect((await harness.callback(state!)).status).not.toBe(200);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
    expect(await seeded.widgetStatus()).toBe('pending');
  });

  /**
   * The same fence, reached from the projection's side.
   *
   * `binding_invalidated_at` is terminal (§7.2): the card has already been
   * repainted to say no link can be offered here. A flow that is still in
   * flight when that happens must not be allowed to finish either, or the
   * thread shows a retired card beside a grant it says was never made.
   */
  it('refuses a callback whose card was retired mid-flow', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as {
      success: boolean;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    const state = new URL(started.authorizationUrl).searchParams.get('state');

    const messages = new MessagesRepository(harness.rawDb);
    await messages.mutateMetadataLocked(seeded.widgetId, (metadata) => ({
      ...metadata,
      widget: {
        ...metadata!.widget!,
        slack_connect: {
          ...metadata!.widget!.slack_connect!,
          binding_invalidated_at: new Date().toISOString(),
        },
      },
    }));

    expect((await harness.callback(state!)).status).not.toBe(200);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
  });

  /**
   * B2 — the kill switch, applied to a flow already in the air.
   *
   * §7.1.4 says switching the lane off stops it GRANTING and not merely
   * repainting. That was true of delivery and of redemption and not of the
   * window between them: a link redeemed a second before an operator threw the
   * switch still came back through the provider and persisted a grant, which is
   * the single outcome someone reaching for a kill switch is trying to stop.
   */
  it('refuses a callback for a flow started before the projection was switched off', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createSlackLaneHarness(provider);
    databases.push(harness.rawDb);
    const seeded = await seedConnect(harness);

    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ connect_token: seeded.token }, paramsFor(harness))) as {
      success: boolean;
      authorizationUrl: string;
    };
    expect(started.success).toBe(true);
    const state = new URL(started.authorizationUrl).searchParams.get('state');

    await setMCPSlackConnectCardEnabled(harness.rawDb, false, harness.user.user_id);

    expect((await harness.callback(state!)).status).not.toBe(200);
    expect(
      await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).toBeNull();
    // The widget is still pending and the failure is durable, so turning the
    // switch back on leaves a card that can be re-offered rather than one
    // stuck mid-sign-in.
    expect(await seeded.widgetStatus()).toBe('pending');
    expect((await seeded.delivery())?.oauth_failed_at).toEqual(expect.any(String));
  });
});

describe('saved-server capability discovery', () => {
  it('reports an MCP SDK 401 with a redacted HTTP authentication diagnostic', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    const sentinel = 'SENTINEL_CONTEXT7_AUTH_RESPONSE';
    mcpClientTestState.connectError = Object.assign(new Error(sentinel), { code: 401 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(result).toMatchObject({
        success: false,
        category: 'provider_rejected',
        error:
          'The provider rejected the MCP authentication request. Review the saved credentials or sign in again.',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'event=mcp_external_failure stage=discovery category=provider_rejected type=HTTPError status=401'
        )
      );
      expect(JSON.stringify({ result, logs: errorSpy.mock.calls })).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports a shared MCP egress timeout as provider availability', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    const sentinel = 'SENTINEL_MCP_EGRESS_TIMEOUT';
    mcpClientTestState.connectError = Object.assign(new Error(sentinel), { code: 'ETIMEDOUT' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(result).toMatchObject({
        success: false,
        category: 'provider_unavailable',
        error:
          'The MCP or OAuth provider is temporarily unreachable. Check the saved configuration and retry.',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'event=mcp_external_failure stage=discovery category=provider_unavailable type=NetworkError code=ETIMEDOUT'
        )
      );
      expect(JSON.stringify({ result, logs: errorSpy.mock.calls })).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
    }
  });

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
  it.each([
    [new FailedRefreshError(), 'token_refresh_failed'],
    [new AmbiguousRefreshError(), 'token_refresh_failed'],
    [new OAuthRefreshExchangeError('transport_ambiguous', true), 'token_refresh_failed'],
    [new InvalidGrantError(), 'needs_reauth'],
  ] as const)(
    'preserves auth-header recovery for %s after centralized grant acquisition',
    async (error, expected) => {
      const provider = await createTestProvider();
      providers.push(provider);
      const harness = await createHarness(provider, 'per_user');
      databases.push(harness.rawDb);
      await authorizeSavedServer(harness);
      const acquire = vi.spyOn(oauthUse, 'acquireMCPOAuthGrant').mockRejectedValueOnce(error);
      try {
        const result = await harness.app
          .service('mcp-servers/oauth-auth-headers')
          .create({ mcp_server_ids: [harness.server.mcp_server_id], force_refresh: true }, {
            user: harness.user,
            tenant: { tenant_id: 'default', source: 'static' },
            authentication: { _isServiceAccount: true },
          } as unknown as AuthenticatedParams);
        expect(result).toEqual({
          headers: { [harness.server.mcp_server_id]: { error: expected } },
        });
        expect(acquire).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'default',
            userId: harness.user.user_id,
            mcpServerId: harness.server.mcp_server_id,
            forceRefresh: true,
          })
        );
        expect(provider.requests.filter((entry) => entry.path === '/token')).toHaveLength(1);
      } finally {
        acquire.mockRestore();
      }
    }
  );

  it('forces one JIT refresh for a daemon-owned retry even before recorded expiry', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);

    const result = (await harness.app.service('mcp-servers/oauth-auth-headers').create(
      {
        mcp_server_ids: [harness.server.mcp_server_id],
        force_refresh: true,
      },
      {
        provider: undefined,
        user: harness.user,
        tenant: { tenant_id: 'default', source: 'static' },
        authentication: { _isServiceAccount: true },
      } as unknown as AuthenticatedParams
    )) as { headers: Record<string, { authorization?: string; error?: string }> };

    expect(result.headers[harness.server.mcp_server_id]).toEqual({
      authorization: 'Bearer stale-refreshed-access-token',
    });
    expect(provider.requests.filter((entry) => entry.path === '/token')).toHaveLength(2);
    await expect(
      new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      )
    ).resolves.toMatchObject({
      oauth_access_token: 'stale-refreshed-access-token',
      oauth_refresh_token: 'stale-rotated-refresh-token',
    });
  });

  it('requires reauthorization when a daemon-owned forced refresh has no refresh token', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    await update(harness.rawDb, userMcpOauthTokens)
      .set({ oauth_refresh_token: null })
      .where(eq(userMcpOauthTokens.mcp_server_id, harness.server.mcp_server_id))
      .run();

    const result = (await harness.app.service('mcp-servers/oauth-auth-headers').create(
      {
        mcp_server_ids: [harness.server.mcp_server_id],
        force_refresh: true,
      },
      {
        provider: undefined,
        user: harness.user,
        tenant: { tenant_id: 'default', source: 'static' },
        authentication: { _isServiceAccount: true },
      } as unknown as AuthenticatedParams
    )) as { headers: Record<string, { authorization?: string; error?: string }> };

    expect(result.headers[harness.server.mcp_server_id]).toEqual({ error: 'needs_reauth' });
    expect(provider.requests.filter((entry) => entry.path === '/token')).toHaveLength(1);
  });

  it('keeps a committed OAuth completion successful when its runtime-hint lookup rejects', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      authorizationUrl: string;
    };
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const tokens = new UserMCPOAuthTokenRepository(harness.rawDb);
    const originalFindById = MCPServerRepository.prototype.findById;
    let lookupCalls = 0;
    const lookup = vi
      .spyOn(MCPServerRepository.prototype, 'findById')
      .mockImplementation(async function (id) {
        lookupCalls += 1;
        const committed = await tokens.getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        );
        if (committed && lookupCalls === 4) {
          throw new Error('SECRET_POST_COMMIT_LOOKUP_FAILURE');
        }
        return originalFindById.call(this, id);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        harness.app
          .service('mcp-servers/oauth-complete')
          .create({ code: 'authorization-code', state, iss: provider.baseUrl }, paramsFor(harness))
      ).resolves.toMatchObject({ success: true, tokenObtained: true });
      await expect(
        tokens.getToken(harness.user.user_id as UserID, harness.server.mcp_server_id as MCPServerID)
      ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[MCP Runtime] event=hint_failed code=oauth_authority_changed'
        )
      );
      expect(lookupCalls).toBe(4);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_POST_COMMIT_LOOKUP_FAILURE');
    } finally {
      lookup.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps a committed OAuth completion successful when Socket.IO throws synchronously', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      authorizationUrl: string;
    };
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const io = harness.app.io as { to: (room: string) => { emit: () => unknown } };
    const originalTo = io.to;
    io.to = () => ({
      emit: () => {
        throw new Error('SECRET_SYNC_COMPLETION_SOCKET_FAILURE');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        harness.app
          .service('mcp-servers/oauth-complete')
          .create({ code: 'authorization-code', state, iss: provider.baseUrl }, paramsFor(harness))
      ).resolves.toMatchObject({ success: true, tokenObtained: true });
      await expect(
        new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        )
      ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[MCP Runtime] event=oauth_post_commit_tail_failed code=completion_notification'
        )
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'SECRET_SYNC_COMPLETION_SOCKET_FAILURE'
      );
    } finally {
      io.to = originalTo;
      warn.mockRestore();
    }
  });

  it('keeps a committed disconnect successful when Socket.IO rejects asynchronously', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    const io = harness.app.io as { to: (room: string) => { emit: () => unknown } };
    const originalTo = io.to;
    io.to = () => ({
      emit: () => Promise.reject(new Error('SECRET_ASYNC_DISCONNECT_SOCKET_FAILURE')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        harness.app
          .service('mcp-servers/oauth-disconnect')
          .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))
      ).resolves.toMatchObject({ success: true });
      await expect(
        new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        )
      ).resolves.toBeNull();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[MCP Runtime] event=oauth_post_commit_tail_failed code=disconnect_notification'
        )
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'SECRET_ASYNC_DISCONNECT_SOCKET_FAILURE'
      );
    } finally {
      io.to = originalTo;
      warn.mockRestore();
    }
  });

  it('logs a closed deployment-configuration diagnostic when the public callback is missing', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    // Callback configuration is frozen when services are registered, not read
    // again from the process environment when the browser flow starts.
    delete process.env.AGOR_BASE_URL;
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(result).toMatchObject({
        success: false,
        recovery: {
          category: 'redirect_configuration_required',
          action: 'configure_redirect',
        },
      });
      expect(provider.requests).toEqual([]);
      expect(harness.emittedBrowserEvents).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'event=mcp_external_failure stage=oauth category=configuration_required type=ConfigurationError code=PUBLIC_BASE_URL_NOT_CONFIGURED reason=oauth_redirect_configuration_required'
        )
      );
    } finally {
      process.env.AGOR_BASE_URL = 'https://agor.example.test';
      errorSpy.mockRestore();
    }
  });

  it.each([undefined, 'https://changed.example.test'])(
    'keeps the startup callback when AGOR_BASE_URL later becomes %s',
    async (changedBaseUrl) => {
      const provider = await createTestProvider();
      providers.push(provider);
      const harness = await createHarness(provider, 'per_user');
      databases.push(harness.rawDb);

      if (changedBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
      else process.env.AGOR_BASE_URL = changedBaseUrl;

      const started = await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(started.success).toBe(true);
      const authorizationUrl = new URL(started.authorizationUrl);
      expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
        'https://agor.example.test/mcp-servers/oauth-callback'
      );
      const state = authorizationUrl.searchParams.get('state');
      expect(state).toBeTruthy();
      expect((await harness.callback(state!)).status).toBe(200);
      await expect(
        new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        )
      ).resolves.toMatchObject({ oauth_access_token: 'sqlite-access-token' });
    }
  );

  it.each([
    [{}, 'disabled', 'dcr_disabled'],
    [{}, 'advertised', 'registration_endpoint_missing'],
    [{}, undefined, 'registration_endpoint_missing'],
    [{ resourcePath: '/wrong/mcp' }, 'advertised', 'protected_resource_mismatch'],
    [{ metadataIssuer: 'https://wrong.example' }, 'advertised', 'issuer_mismatch'],
    [{ pkceMethods: ['plain'] }, 'advertised', 'pkce_required'],
    [{ callbackIssuerSupported: false }, 'advertised', 'profile_rejected'],
  ] as const)(
    'returns exact saved policy and reason %s / %s / %s',
    async (providerOptions, dcrMode, reason) => {
      const provider = await createTestProvider(providerOptions);
      providers.push(provider);
      const harness = await createHarness(provider, undefined, { withoutClient: true });
      databases.push(harness.rawDb);
      const repository = new MCPServerRepository(harness.rawDb);
      await repository.update(harness.server.mcp_server_id, {
        auth: { type: 'oauth', oauth_dcr_mode: dcrMode, oauth_compatibility_mode: 'strict' },
      });
      const before = await repository.findById(harness.server.mcp_server_id);
      const result = await harness.app.service('mcp-servers/oauth-start').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          client_id: 'untrusted-client-must-not-bypass-saved-policy',
        },
        paramsFor(harness)
      );
      expect(result).toMatchObject({
        success: false,
        recovery: {
          failure_reason: reason,
          oauth_policy: {
            effective_mode: 'strict',
            effective_dcr_mode: dcrMode ?? 'advertised',
            dcr_mode_source: dcrMode ? 'explicit' : 'default',
          },
        },
      });
      expect(await repository.findById(harness.server.mcp_server_id)).toEqual(before);
      expect(
        await new UserMCPOAuthTokenRepository(harness.rawDb).listForUser(
          harness.user.user_id as UserID
        )
      ).toEqual([]);
      expect(
        provider.requests.some(({ path }) => ['/register', '/authorize', '/token'].includes(path))
      ).toBe(false);
      expect(harness.emittedBrowserEvents).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('untrusted-client');
    }
  );

  it('reports the policy actually reloaded at the flow boundary, not the earlier probe snapshot', async () => {
    const provider = await createTestProvider({ holdMcpChallenge: true });
    providers.push(provider);
    const harness = await createHarness(provider, undefined, { withoutClient: true });
    databases.push(harness.rawDb);
    const repository = new MCPServerRepository(harness.rawDb);
    await repository.update(harness.server.mcp_server_id, {
      auth: { type: 'oauth', oauth_dcr_mode: 'disabled', oauth_compatibility_mode: 'strict' },
    });
    const starting = harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    await provider.mcpRequested.promise;
    await repository.update(harness.server.mcp_server_id, {
      auth: { type: 'oauth', oauth_compatibility_mode: 'legacy' },
    });
    provider.releaseMcp();
    expect(await starting).toMatchObject({
      success: false,
      recovery: {
        failure_reason: 'dcr_disabled',
        oauth_policy: {
          effective_mode: 'legacy',
          effective_dcr_mode: 'disabled',
          dcr_mode_source: 'explicit',
        },
      },
    });
    expect(provider.requests.some(({ path }) => ['/register', '/token'].includes(path))).toBe(
      false
    );
  });

  it('logs closed Context7-style OAuth metadata incompatibility diagnostics', async () => {
    const provider = await createTestProvider({ resourcePath: '/different/mcp' });
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

      expect(result).toMatchObject({
        success: false,
        recovery: { category: 'metadata_incompatible', action: 'review_compatibility' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'event=mcp_external_failure stage=oauth category=configuration_required type=ConfigurationError reason=oauth_metadata_incompatible'
        )
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('supports explicit OAuth start through the production HA hook chain', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user', {
      deployment: constrainedHaDeployment,
    });
    databases.push(harness.rawDb);
    await new UserMCPOAuthTokenRepository(harness.rawDb).saveToken(
      harness.user.user_id as UserID,
      harness.server.mcp_server_id as MCPServerID,
      {
        accessToken: 'sqlite-access-token',
        refreshToken: 'refresh',
        clientId: 'saved-client-id',
        expiresAt: new Date(Date.now() + 3_600_000),
      }
    );
    registerProductionHooksForHarness(harness);

    await expect(
      harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))
    ).resolves.toMatchObject({ success: true, tools: [] });
    const started = await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    expect(started).toMatchObject({ success: true, attempt_id: expect.any(String) });
    expect(started).not.toHaveProperty('state');
  });

  it('promotes an HA capability probe into the durable browser flow', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user', {
      deployment: constrainedHaDeployment,
    });
    databases.push(harness.rawDb);
    registerProductionHooksForHarness(harness);
    const browserReservation = await reserveBrowserEvent(harness, 'discover');

    const discovery = harness.app.service('mcp-servers/discover').create(
      {
        mcp_server_id: harness.server.mcp_server_id,
        oauth_browser_event: browserReservation,
      },
      paramsFor(harness)
    );

    const authorizationUrl = await harness.nextAuthorizationUrl();
    const state = new URL(authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    expect((await harness.callback(state!)).status).toBe(200);
    await expect(discovery).resolves.toMatchObject({ success: true, tools: [] });
    expect(provider.requests.map((request) => request.path)).toContain('/token');
    expect(harness.emittedBrowserEvents).toHaveLength(1);
  });

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
      // Keep the SDK error seam reachable without an OAuth grant: saved OAuth
      // discovery now correctly refuses before transport when no grant exists.
      await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
        auth: { type: 'none' },
      });
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

  // -------------------------------------------------------------------------
  // The front channel.
  //
  // The shape of the sandbox failure against `com.datadoghq/mcp`: discovery
  // succeeded, DCR succeeded, and the provider's authorize endpoint answered
  // `invalid_request — Mismatching redirect URI` on its own page, which never
  // redirects to Agor. Its cause is not established; see §7.1.16 of
  // `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
  // -------------------------------------------------------------------------

  const dcrCatalogEntry = (name: string, remoteUrl: string): MCPCatalogEntry =>
    ({
      name,
      title: 'Registration identity fixture',
      category: 'developer-tools',
      capabilities: ['testing'],
      benefit: 'Exercises DCR client identity against the front channel.',
      starter_prompt: 'Exercise registration identity.',
      permission_disclosure: 'Fixture only.',
      popularity_rank: 999_990,
      transport: 'streamable-http',
      remote_url: remoteUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
    }) as MCPCatalogEntry;

  const startWithCatalogHarness = async (provider: TestProvider, entryName: string) => {
    const catalogEntry = dcrCatalogEntry(entryName, provider.savedMcpUrl);
    // This flow runs all the way to a live authorization URL, so the catalog
    // is read more times than the fixed queue an aborted flow needs. Restore
    // the shared mock's default afterwards; nothing else in this file resets
    // it, and a leaked persistent value would answer every later test.
    const catalogMock = vi.mocked(loadCatalog);
    const previousImplementation = catalogMock.getMockImplementation();
    catalogMock.mockResolvedValue([catalogEntry]);
    onTestFinished(() => {
      catalogMock.mockReset();
      if (previousImplementation) catalogMock.mockImplementation(previousImplementation);
    });
    const harness = await createHarness(provider, undefined, { catalogEntry });
    databases.push(harness.rawDb);
    const started = (await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
      success: boolean;
      attempt_id?: string;
      authorizationUrl?: string;
    };
    return { harness, started };
  };

  it('registers under the deployed client name, and the front channel accepts that client', async () => {
    const provider = await createTestProvider({ serveDynamicRegistration: true });
    providers.push(provider);
    const { harness, started } = await startWithCatalogHarness(provider, 'test/dcr-front-channel');
    expect(started).toMatchObject({ success: true });

    const authorizationUrl = new URL(started.authorizationUrl!);
    const registered = provider.registeredClients.get(
      authorizationUrl.searchParams.get('client_id')!
    );
    // The name every deployed registration was made under; a different one
    // re-registers every deployment's clients (see MCP_OAUTH_DCR_CLIENT_NAME).
    expect(registered?.clientName).toBe('Agor MCP Client');
    expect(registered?.redirectUris).toEqual([
      'https://agor.example.test/mcp-servers/oauth-callback',
    ]);

    // The front channel accepts the client Agor registered, and the callback
    // completes — the assertion the fixture could not make before, because it
    // had no `/authorize` handler at all.
    const authorizeResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorizeResponse.status).toBe(302);
    expect(provider.authorizeVerdicts.map((verdict) => verdict.outcome)).toEqual(['redirect']);

    const callback = await harness.callback(authorizationUrl.searchParams.get('state')!);
    expect(callback.status).toBe(200);
  });

  it('cannot see a front-channel redirect-URI rejection, and leaves the attempt pending', async () => {
    // The provider registers a client bound to a redirect URI other than the
    // one it echoes back. DCR therefore looks clean —
    // `validateDynamicClientRegistration` sees its own value in
    // `redirect_uris` — and the rejection happens on the provider's own page,
    // which never redirects to Agor.
    const provider = await createTestProvider({
      serveDynamicRegistration: true,
      registrationStoresRedirectUri: 'https://stale-agor.example.test/mcp-servers/oauth-callback',
    });
    providers.push(provider);
    const { harness, started } = await startWithCatalogHarness(
      provider,
      'test/dcr-stored-not-echoed'
    );

    const authorizationUrl = new URL(started.authorizationUrl!);
    const registerRequest = provider.requests.find((entry) => entry.path === '/register');
    // What the provider echoed is ours; what it stored is not. Agor has no
    // local way to tell those apart.
    expect(registerRequest?.jsonBody?.redirect_uris).toEqual([
      'https://agor.example.test/mcp-servers/oauth-callback',
    ]);
    const clientId = authorizationUrl.searchParams.get('client_id')!;
    expect(provider.registeredClients.get(clientId)?.redirectUris).toEqual([
      'https://stale-agor.example.test/mcp-servers/oauth-callback',
    ]);

    const authorizeResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorizeResponse.status).toBe(400);
    expect(await authorizeResponse.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Mismatching redirect URI',
    });
    expect(provider.authorizeVerdicts).toEqual([{ clientId, outcome: 'invalid_request' }]);

    // Nothing came back to Agor: no callback, no token, and an attempt that
    // is still pending. The only durable proxy is its eventual expiry, which
    // is why that is classified `authorization_never_returned`.
    expect(provider.requests.some((entry) => entry.path === '/token')).toBe(false);
    const attemptId = started.attempt_id!;
    expect(attemptId).toBeTruthy();
    await expect(
      harness.app.service('mcp-servers/oauth-attempt-status').get(attemptId, paramsFor(harness))
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('rejects an unsafe deployment callback before OAuth discovery or durable DCR', async () => {
    const provider = await createTestProvider({ rejectDynamicRegistration: true });
    providers.push(provider);
    const catalogEntry = {
      name: 'test/oauth-start-unsafe-callback',
      title: 'Unsafe callback ordering fixture',
      category: 'developer-tools',
      capabilities: ['testing'],
      benefit: 'Exercises callback validation before provider discovery.',
      starter_prompt: 'Exercise callback validation ordering.',
      permission_disclosure: 'Fixture only.',
      popularity_rank: 999_997,
      transport: 'streamable-http',
      remote_url: provider.savedMcpUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
    } as MCPCatalogEntry;
    vi.mocked(loadCatalog).mockResolvedValueOnce([catalogEntry]);
    const resolveDynamicClientRegistration = vi.fn();
    process.env.AGOR_BASE_URL = 'http://10.33.92.175:3030';
    const harness = await createHarness(provider, undefined, {
      catalogEntry,
      durableAuthority: durableAuthorityWithCreate(async () => crypto.randomUUID() as never),
      durableClientRegistrationAuthority: {
        resolve: resolveDynamicClientRegistration,
        lockExactCurrentForAttempt: vi.fn(async () => true),
        invalidateForServer: vi.fn(),
        maintain: vi.fn(),
      } as unknown as NonNullable<RegisterServicesContext['mcpOAuthClientRegistrationAuthority']>,
      lockGrantConfiguration: vi.fn(async () => undefined),
    });
    databases.push(harness.rawDb);

    const result = await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

    expect(result).toMatchObject({
      success: false,
      recovery: { category: 'redirect_configuration_required' },
    });
    expect(provider.requests).toEqual([]);
    expect(resolveDynamicClientRegistration).not.toHaveBeenCalled();
    expect(harness.emittedBrowserEvents).toEqual([]);
  });

  it('does not activate constrained-HA OAuth when public-origin capability is false', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider, undefined, {
      deployment: {
        mode: 'ha',
        capabilities: { mcpOAuth: false },
      } as RegisterServicesContext['deployment'],
    });
    databases.push(harness.rawDb);

    const result = await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

    expect(result).toMatchObject({
      success: false,
      recovery: { category: 'redirect_configuration_required' },
    });
    expect(provider.requests).toEqual([]);
  });

  it('routes saved-row DCR through the durable fleet authority before creating a flow', async () => {
    const provider = await createTestProvider({ rejectDynamicRegistration: true });
    providers.push(provider);
    const catalogEntry = {
      name: 'test/durable-dcr-authority',
      title: 'Durable DCR authority fixture',
      category: 'developer-tools',
      capabilities: ['testing'],
      benefit: 'Exercises fleet DCR wiring.',
      starter_prompt: 'Exercise durable DCR.',
      permission_disclosure: 'Fixture only.',
      popularity_rank: 999_997,
      transport: 'streamable-http',
      remote_url: provider.savedMcpUrl,
      has_remote: true,
      has_package: false,
      auth_type: 'oauth',
    } as MCPCatalogEntry;
    vi.mocked(loadCatalog)
      .mockResolvedValueOnce([catalogEntry])
      .mockResolvedValueOnce([catalogEntry]);
    const registrationId = crypto.randomUUID();
    const resolve = vi.fn(async () => ({
      registration: {
        client_id: 'durably-reused-client',
        redirect_uris: ['https://agor.example.test/mcp-servers/oauth-callback'],
        token_endpoint_auth_method: 'none',
      },
      registrationId,
    }));
    const lockExactCurrentForAttempt = vi.fn(async () => true);
    const durableClientRegistrationAuthority = {
      resolve,
      lockExactCurrentForAttempt,
      invalidateForServer: vi.fn(),
      maintain: vi.fn(),
    } as unknown as NonNullable<RegisterServicesContext['mcpOAuthClientRegistrationAuthority']>;
    const harness = await createHarness(provider, undefined, {
      catalogEntry,
      durableAuthority: durableAuthorityWithCreate(async () => crypto.randomUUID() as never),
      durableClientRegistrationAuthority,
      lockGrantConfiguration: vi.fn(async () => undefined),
    });
    databases.push(harness.rawDb);

    const started = await harness.app
      .service('mcp-servers/oauth-start')
      .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));

    expect(started).toMatchObject({ success: true, attempt_id: expect.any(String) });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'default',
        mcpServerId: harness.server.mcp_server_id,
        serverConfigVersion: harness.server.config_version,
        registrationEndpoint: `${provider.baseUrl}/register`,
        resourceUri: provider.savedMcpUrl,
        redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
        compatibilityMode: 'marketplace',
      }),
      expect.any(Function),
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        assertServerCurrent: expect.any(Function),
      })
    );
    expect(lockExactCurrentForAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'default',
        serverId: harness.server.mcp_server_id,
        serverConfigVersion: harness.server.config_version,
        registrationId,
      })
    );
    expect(provider.requests.filter((entry) => entry.path === '/register')).toEqual([]);
  });

  it('keeps SQLite DCR process-local and refuses the PostgreSQL registration reset path', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);

    await expect(
      harness.app
        .service('mcp-servers/oauth-client-registration-reset')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))
    ).rejects.toThrow(/only on PostgreSQL/i);
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
          oauth_policy: {
            effective_mode: 'marketplace',
            effective_dcr_mode: 'advertised',
            dcr_mode_source: 'default',
          },
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
        .mockImplementation(async function (this: UserMCPOAuthTokenRepository, ...args) {
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
  }, 30_000);

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
    let reservationExpiresAt: number | null = null;

    const reserve = async (tenant: number, user: number, socket: number) => {
      const params = addLiveAuthority(
        harness,
        `tenant-${tenant}`,
        `tenant-${tenant}-user-${user}`,
        `tenant-${tenant}-user-${user}-socket-${socket}`
      );
      const reservation = (await service.create(
        { operation: 'discover', mcp_server_id: harness.server.mcp_server_id },
        params
      )) as MCPOAuthBrowserReservation;
      reservationExpiresAt ??= reservation.expires_at;
      return reservation;
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

      expect(reservationExpiresAt).not.toBeNull();
      clock.mockReturnValue(reservationExpiresAt! + 1);
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

  it.each(['client_credentials', undefined] as const)(
    'saved machine configuration (%s) returns configuration recovery without provider work',
    async (grantType) => {
      const provider = await createTestProvider();
      providers.push(provider);
      const harness = await createHarness(provider);
      databases.push(harness.rawDb);
      await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
        auth: {
          ...harness.server.auth!,
          oauth_grant_type: grantType,
          oauth_client_id: 'machine-client',
          oauth_client_secret: 'synthetic-machine-secret',
          oauth_token_url: `${provider.baseUrl}/token`,
        },
      });
      const requestsBefore = provider.requests.length;
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      expect(result).toMatchObject({
        success: false,
        recovery: { category: 'configuration_required', action: 'review_configuration' },
      });
      const execution = await harness.app
        .service('mcp-servers/oauth-auth-headers')
        .create(
          { mcp_server_ids: [harness.server.mcp_server_id] },
          { ...paramsFor(harness), provider: undefined }
        );
      expect(execution.headers[harness.server.mcp_server_id]).toMatchObject({
        error: 'client_credentials_configuration_required',
        recovery: { action: 'review_configuration' },
      });
      expect(provider.requests).toHaveLength(requestsBefore);
    }
  );

  it('does not convert transient acquisition contention into reauth at either service boundary', async () => {
    const provider = await createTestProvider();
    providers.push(provider);
    const harness = await createHarness(provider);
    databases.push(harness.rawDb);
    const acquire = vi
      .spyOn(oauthUse, 'acquireMCPOAuthGrant')
      .mockRejectedValue(new oauthUse.MCPOAuthRefreshBusyError());
    try {
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      expect(result).toMatchObject({ success: false, recovery: { action: 'retry' } });
      const execution = await harness.app
        .service('mcp-servers/oauth-auth-headers')
        .create(
          { mcp_server_ids: [harness.server.mcp_server_id] },
          { ...paramsFor(harness), provider: undefined }
        );
      expect(execution.headers[harness.server.mcp_server_id]).toMatchObject({
        error: 'refresh_in_progress',
        recovery: { action: 'retry' },
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      acquire.mockRestore();
    }
  });

  it.each(['per_user', 'shared'] as const)(
    'GitLab-shaped %s callback expires then discovery rotates the durable pair',
    async (mode) => {
      const provider = await createTestProvider({ gitlab: true });
      providers.push(provider);
      const harness = await createHarness(provider, mode);
      databases.push(harness.rawDb);
      // Legacy forms could save this default even for browser OAuth. A bound
      // grant, not the form default, remains the credential authority.
      await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
        auth: { ...harness.server.auth!, oauth_grant_type: 'client_credentials' },
      });
      const started = Date.now();
      await authorizeSavedServer(harness);
      const subject = mode === 'shared' ? null : (harness.user.user_id as UserID);
      const repository = new UserMCPOAuthTokenRepository(harness.rawDb);
      const saved = await repository.getToken(subject, harness.server.mcp_server_id as MCPServerID);
      expect(saved?.oauth_token_expires_at?.getTime()).toBeGreaterThanOrEqual(started + 7_200_000);
      expect(saved?.oauth_refresh_token).toBe('refresh');
      expect(saved?.oauth_redirect_uri).toBeTruthy();
      await update(harness.rawDb, userMcpOauthTokens)
        .set({ oauth_token_expires_at: new Date(1) })
        .where(eq(userMcpOauthTokens.mcp_server_id, harness.server.mcp_server_id))
        .run();
      mcpClientTestState.tools = [{ name: 'gitlab_list_projects' }];
      const result = await harness.app
        .service('mcp-servers/discover')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      expect(result).toMatchObject({ success: true, capabilities: { tools: 1 } });
      const rotated = await repository.getToken(
        subject,
        harness.server.mcp_server_id as MCPServerID
      );
      expect(rotated).toMatchObject({
        oauth_access_token: 'stale-refreshed-access-token',
        oauth_refresh_token: 'stale-rotated-refresh-token',
        refresh_status: 'idle',
        refresh_generation: 1,
        refresh_success_generation: 1,
      });
      expect(rotated?.oauth_token_expires_at?.getTime()).toBeGreaterThan(Date.now() + 7_190_000);
      expect(rotated?.grant_generation).toBe(saved?.grant_generation);
      expect(
        (await new MCPServerRepository(harness.rawDb).findById(harness.server.mcp_server_id))?.tools
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'gitlab_list_projects' })])
      );
    }
  );

  it.each(['invalid', 'malformed'] as const)(
    'discovery reports reauth and never replays a %s rotating refresh',
    async (failure) => {
      const provider = await createTestProvider({
        gitlab: true,
        invalidRefresh: failure === 'invalid',
        malformedRefresh: failure === 'malformed',
      });
      providers.push(provider);
      const harness = await createHarness(provider, 'per_user');
      databases.push(harness.rawDb);
      await authorizeSavedServer(harness);
      await update(harness.rawDb, userMcpOauthTokens)
        .set({ oauth_token_expires_at: new Date(1) })
        .where(eq(userMcpOauthTokens.mcp_server_id, harness.server.mcp_server_id))
        .run();
      const discover = () =>
        harness.app
          .service('mcp-servers/discover')
          .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
      expect(await discover()).toMatchObject({
        success: false,
        recovery: { action: 'reauthenticate' },
      });
      const repository = new UserMCPOAuthTokenRepository(harness.rawDb);
      const saved = await repository.getToken(
        harness.user.user_id as UserID,
        harness.server.mcp_server_id as MCPServerID
      );
      if (failure === 'invalid') expect(saved).toBeNull();
      else expect(saved?.refresh_status).toBe('ambiguous');
      const before = provider.requests.filter((r) => r.path === '/token').length;
      expect(await discover()).toMatchObject({ success: false });
      expect(provider.requests.filter((r) => r.path === '/token')).toHaveLength(before);
    }
  );

  it.each(['per_user', 'shared'] as const)(
    'auth headers require reauthorization for a quarantined %s grant without replay',
    async (mode) => {
      const provider = await createTestProvider({ gitlab: true });
      providers.push(provider);
      const harness = await createHarness(provider, mode);
      databases.push(harness.rawDb);
      await authorizeSavedServer(harness);
      await update(harness.rawDb, userMcpOauthTokens)
        .set({ refresh_status: 'ambiguous', oauth_token_expires_at: new Date(1) })
        .where(eq(userMcpOauthTokens.mcp_server_id, harness.server.mcp_server_id))
        .run();
      const before = provider.requests.length;
      const result = await harness.app
        .service('mcp-servers/oauth-auth-headers')
        .create(
          { mcp_server_ids: [harness.server.mcp_server_id] },
          { ...paramsFor(harness), provider: undefined }
        );
      expect(result.headers[harness.server.mcp_server_id]).toEqual({ error: 'needs_reauth' });
      expect(provider.requests).toHaveLength(before);
      expect(
        (
          await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
            mode === 'shared' ? null : (harness.user.user_id as UserID),
            harness.server.mcp_server_id as MCPServerID
          )
        )?.refresh_status
      ).toBe('ambiguous');
    }
  );

  it('coalesces concurrent GitLab refreshes and quarantines a dispatch left by a dead SQLite daemon', async () => {
    const provider = await createTestProvider({ gitlab: true, holdRefresh: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'per_user');
    databases.push(harness.rawDb);
    await authorizeSavedServer(harness);
    const refresh = () =>
      harness.app
        .service('mcp-servers/oauth-refresh')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness));
    const first = refresh();
    await provider.refreshRequested.promise;
    const second = refresh();
    provider.releaseRefresh();
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });
    expect(provider.requests.filter((r) => r.path === '/token')).toHaveLength(2); // callback + one rotation
    await update(harness.rawDb, userMcpOauthTokens)
      .set({ refresh_status: 'refreshing', oauth_token_expires_at: new Date(1) })
      .where(eq(userMcpOauthTokens.mcp_server_id, harness.server.mcp_server_id))
      .run();
    expect(await refresh()).toMatchObject({ success: false, error: 'needs_reauth' });
    expect(provider.requests.filter((r) => r.path === '/token')).toHaveLength(2);
    expect(
      (
        await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          harness.user.user_id as UserID,
          harness.server.mcp_server_id as MCPServerID
        )
      )?.refresh_status
    ).toBe('ambiguous');
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

  it('keeps shared client-credentials token tests probe-only, without retaining or replacing consent', async () => {
    const { getOAuthCacheStats } = await import('@agor/core/tools/mcp/oauth-auth');
    const provider = await createTestProvider({ clientCredentialsOnly: true });
    providers.push(provider);
    const harness = await createHarness(provider, 'shared');
    databases.push(harness.rawDb);
    await new MCPServerRepository(harness.rawDb).update(harness.server.mcp_server_id, {
      auth: {
        type: 'oauth',
        oauth_mode: 'shared',
        oauth_client_id: 'saved-client-id',
        oauth_client_secret: 'saved-client-secret',
        oauth_token_url: `${provider.baseUrl}/token`,
      },
    });
    const grants = new UserMCPOAuthTokenRepository(harness.rawDb);
    const cacheSize = getOAuthCacheStats().totalEntries;
    for (const existingGrant of [false, true]) {
      if (existingGrant)
        await grants.saveToken(
          null,
          harness.server.mcp_server_id,
          {
            accessToken: 'existing-shared-consent',
          },
          harness.user.user_id
        );
      const before = await grants.getToken(null, harness.server.mcp_server_id);
      const tested = await harness.app.service('mcp-servers/test-oauth').create(
        {
          mcp_server_id: harness.server.mcp_server_id,
          mcp_url: provider.savedMcpUrl,
          granted_by_user_id: 'untrusted-request-consenter',
        },
        paramsFor(harness)
      );
      expect(tested).toMatchObject({
        success: true,
        oauthType: 'client_credentials',
        tokenValid: true,
      });
      expect(await grants.getToken(null, harness.server.mcp_server_id)).toEqual(before);
      expect(getOAuthCacheStats().totalEntries).toBe(cacheSize);
    }
    expect(provider.requests.filter((request) => request.path === '/token')).toHaveLength(2);
  });

  it.each(['provider-exchange', 'persistence'] as const)(
    'retires shared consent when A is hard-deleted during %s, including status for B',
    async (phase) => {
      const provider = await createTestProvider({ holdTokenRequests: [1] });
      providers.push(provider);
      const harness = await createHarness(provider, 'shared');
      databases.push(harness.rawDb);
      const b = await new UsersRepository(harness.rawDb).create({
        email: `remaining-admin-${generateId()}@example.test`,
        role: 'admin',
      });
      // Keep server ownership/configuration and B's access independent of A.
      await update(harness.rawDb, mcpServers)
        .set({ owner_user_id: b.user_id })
        .where(eq(mcpServers.mcp_server_id, harness.server.mcp_server_id))
        .run();
      const started = (await harness.app
        .service('mcp-servers/oauth-start')
        .create({ mcp_server_id: harness.server.mcp_server_id }, paramsFor(harness))) as {
        authorizationUrl: string;
      };
      const callback = harness.callback(
        new URL(started.authorizationUrl).searchParams.get('state')!
      );
      await provider.waitForTokenRequest(1);
      const atWrite = deferred<void>();
      const releaseWrite = deferred<void>();
      const original = UserMCPOAuthTokenRepository.prototype.saveToken;
      const spy =
        phase === 'persistence'
          ? vi
              .spyOn(UserMCPOAuthTokenRepository.prototype, 'saveToken')
              .mockImplementation(async function (this: UserMCPOAuthTokenRepository, ...args) {
                atWrite.resolve();
                await releaseWrite.promise;
                return original.apply(this, args);
              })
          : undefined;
      try {
        if (phase === 'persistence') {
          provider.releaseTokenRequest(1);
          await atWrite.promise;
        }
        await new UsersRepository(harness.rawDb).delete(harness.user.user_id);
      } finally {
        provider.releaseTokenRequest(1);
        releaseWrite.resolve();
        spy?.mockRestore();
      }
      expect((await callback).status).not.toBe(200);
      expect(
        await new UserMCPOAuthTokenRepository(harness.rawDb).getToken(
          null,
          harness.server.mcp_server_id
        )
      ).toBeNull();
      const statusParams: AuthenticatedParams = {
        ...paramsFor(harness),
        provider: 'rest',
        user: b,
        connection: undefined,
      };
      expect(await harness.app.service('mcp-servers/oauth-status').find(statusParams)).toEqual({
        authenticated_server_ids: [],
      });
    }
  );

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
      granted_by_user_id: harness.user.user_id,
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
      repository.saveToken(
        subjectUserId,
        harness.server.mcp_server_id as MCPServerID,
        {
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
        },
        harness.user.user_id as UserID
      );
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
