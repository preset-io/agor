import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import {
  BranchRepository,
  CapabilityPolicyRepository,
  createDatabaseAsync,
  generateId,
  MCPServerRepository,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseTransaction,
  SessionMCPServerRepository,
  SessionRepository,
  setMCPEgressGatewayMode,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { refreshAndPersistToken } from '@agor/core/tools/mcp/oauth-refresh';
import {
  capabilityPolicyPresetCapabilities,
  type MCPServer,
  type MCPServerID,
  TaskStatus,
  type UserID,
  type UUID,
} from '@agor/core/types';
import type { OutboundDnsLookup } from '@agor/core/utils/safe-outbound-fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueMCPEgressCapability } from './capability.js';
import {
  coordinateMCPEgressRolloutChange,
  coordinateMCPServerMutationAfterWrite,
  coordinateSessionMCPRevocation,
} from './coordination.js';
import {
  MCPEgressGateway,
  MCPEgressGatewayError,
  mcpEgressEligibility,
  mcpEgressMaterialHash,
  mcpOAuthGrantIdentity,
  projectMCPServerForExecutor,
} from './gateway.js';
import { createMCPEgressHttpHandler } from './http-handler.js';

const listeners: http.Server[] = [];
const databases: Array<{ $client?: { close?: () => void } }> = [];
const files: string[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

function asLocalhost(url: string): string {
  return url.replace('127.0.0.1', 'localhost');
}

afterEach(async () => {
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.$client?.close?.();
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

interface HarnessOptions {
  dbUrl?: string;
  server: Pick<MCPServer, 'transport'> &
    Partial<
      Pick<
        MCPServer,
        'url' | 'command' | 'args' | 'env' | 'headers' | 'auth' | 'tool_permissions' | 'scope'
      >
    >;
  jwtSecret?: string;
  resolveDns?: OutboundDnsLookup;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: Date | null;
  separatePrincipal?: boolean;
  branchRbacEnabled?: boolean;
  authoritySnapshotCheckpoint?: () => Promise<void>;
  oauthAuthHeadersCreate?: (params: {
    mcp_egress_assert_current?: () => Promise<void>;
  }) => Promise<{ headers: Record<string, { authorization?: string; error?: string }> }>;
  capabilityServerTransform?: (server: MCPServer) => MCPServer;
}

async function harness(options: HarnessOptions) {
  const rawDb = await createDatabaseAsync({
    dialect: 'sqlite',
    url: options.dbUrl ?? ':memory:',
  });
  databases.push(rawDb as typeof rawDb & { $client?: { close?: () => void } });
  await runMigrations(rawDb);
  const user = await new UsersRepository(rawDb).create({
    email: `${randomUUID()}@example.com`,
    name: 'Gateway transport owner',
    role: 'member',
  });
  const principal = options.separatePrincipal
    ? await new UsersRepository(rawDb).create({
        email: `${randomUUID()}@example.com`,
        name: 'Gateway prompting principal',
        role: 'member',
      })
    : user;
  const repo = await new RepoRepository(rawDb).create({
    repo_id: randomUUID() as UUID,
    slug: `gateway-${randomUUID()}`,
    name: 'Gateway test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/gateway.git',
    local_path: `/tmp/${randomUUID()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(rawDb).create({
    branch_id: randomUUID(),
    repo_id: repo.repo_id,
    name: 'gateway-test',
    ref: 'main',
    branch_unique_id: Date.now() % 1_000_000,
    path: `/tmp/${randomUUID()}`,
    created_by: user.user_id as UUID,
  });
  if (options.separatePrincipal) {
    const policies = new CapabilityPolicyRepository(rawDb);
    const current = await policies.getBranchPolicy(branch.branch_id);
    const config = structuredClone(current.override_config!);
    config.access.sharing_mode = 'shared';
    config.access.entries = [
      {
        entry_id: generateId(),
        principal: { principal_type: 'user', user_id: principal.user_id },
        preset: 'collaborator',
        capabilities:
          capabilityPolicyPresetCapabilities('branch_access', 'collaborator', 'read') ?? [],
        fs_access: 'read',
      },
    ];
    config.allow_shared_session_prompts = true;
    await policies.replaceBranchPolicy(
      branch.branch_id,
      { ...current, override_config: config },
      user.user_id
    );
    await policies.setWorkspacePreferences({ session_sharing_enabled: true }, user.user_id);
  }
  const session = await new SessionRepository(rawDb).create({
    session_id: randomUUID(),
    branch_id: branch.branch_id,
    agentic_tool: 'codex',
    created_by: user.user_id as UserID,
    sdk_home_scope: options.separatePrincipal ? 'branch' : 'execution_home',
  });
  const task = await new TaskRepository(rawDb).create({
    task_id: randomUUID(),
    session_id: session.session_id,
    created_by: principal.user_id,
    full_prompt: 'exercise authoritative MCP egress',
    status: TaskStatus.RUNNING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'test' },
    tool_use_count: 0,
  });
  const server = await new MCPServerRepository(rawDb).create({
    name: `gateway-${randomUUID()}`,
    ...options.server,
    scope: options.server.scope ?? 'global',
    source: 'user',
    enabled: true,
    owner_user_id: principal.user_id as UserID,
  });
  if (server.scope === 'session') {
    await new SessionMCPServerRepository(rawDb).addServer(session.session_id, server.mcp_server_id);
  }
  const rolloutMode = 'enforced' as const;
  await setMCPEgressGatewayMode(rawDb, rolloutMode, user.user_id);
  let grantIdentity: string | undefined;
  const oauthTokenUserId =
    server.auth?.type === 'oauth' && (server.auth.oauth_mode ?? 'per_user') === 'shared'
      ? null
      : (principal.user_id as UserID);
  if (server.auth?.type === 'oauth') {
    await new UserMCPOAuthTokenRepository(rawDb).saveToken(oauthTokenUserId, server.mcp_server_id, {
      accessToken: options.oauthAccessToken ?? 'oauth-access-token-initial',
      refreshToken: options.oauthRefreshToken,
      expiresAt: options.oauthExpiresAt,
      clientId: server.auth.oauth_client_id ?? 'gateway-test-oauth-client',
      grantBinding: {
        generation: 1,
        version: 4,
        fingerprint: 'gateway-test-binding-v1',
        metadataUri: 'https://auth.example.test/.well-known/oauth-protected-resource',
        resourceUri: server.url ?? 'https://provider.example.test/mcp',
        issuer: 'https://auth.example.test',
        authorizationEndpoint: 'https://auth.example.test/authorize',
        tokenEndpoint: server.auth.oauth_token_url ?? 'https://auth.example.test/token',
        redirectUri: 'https://daemon.example.test/mcp-servers/oauth-callback',
      },
    });
    grantIdentity = mcpOAuthGrantIdentity(
      await new UserMCPOAuthTokenRepository(rawDb).getToken(oauthTokenUserId, server.mcp_server_id)
    );
  }
  const jwtSecret = options.jwtSecret ?? 'gateway-test-signing-key';
  const app = {
    get: () => undefined,
    service: (path: string) => {
      if (path !== 'mcp-servers/oauth-auth-headers') return {};
      return {
        create: async (_data: unknown, params: unknown) => {
          if (options.oauthAuthHeadersCreate) {
            return options.oauthAuthHeadersCreate(
              params as { mcp_egress_assert_current?: () => Promise<void> }
            );
          }
          const current = await new UserMCPOAuthTokenRepository(rawDb).getToken(
            oauthTokenUserId,
            server.mcp_server_id
          );
          return {
            headers: {
              [server.mcp_server_id]: current
                ? { authorization: `Bearer ${current.oauth_access_token}` }
                : { error: 'needs_reauth' },
            },
          };
        },
      };
    },
  } as unknown as Application;
  const gateway = new MCPEgressGateway({
    db: rawDb as unknown as TenantScopeAwareDatabase,
    app,
    jwtSecret,
    branchRbacEnabled: options.branchRbacEnabled ?? false,
    allowLocalhostHttp: true,
    resolveDns: options.resolveDns,
    authoritySnapshotCheckpoint: options.authoritySnapshotCheckpoint,
  });
  const capability = issueMCPEgressCapability(
    {
      tid: 'default',
      task_id: task.task_id,
      session_id: session.session_id,
      principal_user_id: principal.user_id,
      credential_user_id: principal.user_id,
      mcp_server_id: server.mcp_server_id,
      config_version: server.config_version ?? 1,
      material_hash: mcpEgressMaterialHash(
        options.capabilityServerTransform?.(server) ?? server,
        {},
        jwtSecret
      ),
      grant_identity: grantIdentity,
      rollout_mode: rolloutMode,
      jti: randomUUID(),
    },
    jwtSecret
  );
  const request = (method = 'POST', body?: string) =>
    gateway.forward({
      serverId: server.mcp_server_id,
      headers: new Headers({
        'x-agor-mcp-capability': capability,
        authorization: 'executor-injected-authorization',
      }),
      method,
      body: body ? new TextEncoder().encode(body) : undefined,
    });
  const routeRequest = async (method = 'POST', body?: string) => {
    let status = 200;
    let payload: unknown;
    let responseBody: unknown;
    const response = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(value: unknown) {
        payload = value;
        this.headersSent = true;
        return this;
      },
      end(value?: unknown) {
        responseBody = value;
        this.headersSent = true;
        return this;
      },
    };
    await createMCPEgressHttpHandler(gateway)(
      {
        params: { serverId: server.mcp_server_id },
        body: body ? JSON.parse(body) : undefined,
        headers: { 'x-agor-mcp-capability': capability },
        method,
      } as never,
      response as never
    );
    return { status, payload, responseBody };
  };
  return {
    rawDb,
    gateway,
    server,
    session,
    task,
    user,
    principal,
    branch,
    capability,
    jwtSecret,
    oauthTokenUserId,
    request,
    routeRequest,
  };
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });

describe('authoritative MCP gateway real transport', () => {
  it('projects only bounded HTTP servers and excludes stdio and ask authority up front', () => {
    expect(
      mcpEgressEligibility({ transport: 'stdio', command: 'never-spawn' } as MCPServer)
    ).toEqual({ eligible: false, reason: 'transport_not_mediated' });
    expect(
      mcpEgressEligibility({
        transport: 'http',
        url: 'https://provider.example/mcp',
        tool_permissions: { destructive: 'ask' },
      } as MCPServer)
    ).toEqual({ eligible: false, reason: 'approval_not_mediated' });
    for (const template of [
      '{{@root.user.env.SECRET}}',
      '{{this.user.env.SECRET}}',
      '{{./user.env.SECRET}}',
      '{{lookup user.env "SECRET"}}',
      '{{#with user}}{{env.SECRET}}{{/with}}',
    ]) {
      expect(
        mcpEgressEligibility({
          transport: 'http',
          url: `https://provider.example/${template}`,
        } as MCPServer)
      ).toEqual({ eligible: false, reason: 'template_configuration' });
    }
    const projected = projectMCPServerForExecutor(
      {
        mcp_server_id: 'server-safe-shape',
        transport: 'http',
        url: 'https://provider.example/credential-path-value',
        command: 'never-export',
        args: ['never-export'],
        env: { PROVIDER_KEY: 'never-export' },
        headers: { 'X-Provider-Key': 'never-export' },
        auth: { type: 'bearer', token: 'never-export' },
      } as MCPServer,
      'https://daemon.example/mcp-egress/server-safe-shape',
      'opaque-capability'
    );
    expect(projected).toMatchObject({
      transport: 'http',
      url: 'https://daemon.example/mcp-egress/server-safe-shape',
      headers: { 'X-Agor-Mcp-Capability': 'opaque-capability' },
    });
    expect(projected).not.toHaveProperty('auth');
    expect(projected).not.toHaveProperty('env');
    expect(projected).not.toHaveProperty('command');
    expect(projected).not.toHaveProperty('args');
  });

  it('injects the reusable credential only at the daemon-owned provider boundary', async () => {
    const secret = 'provider-secret-never-exported';
    let authorization: string | undefined;
    const url = await listen((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json', 'x-private': secret });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const h = await harness({
      server: { transport: 'http', url: `${url}/mcp`, auth: { type: 'bearer', token: secret } },
    });

    expect(h.capability).not.toContain(secret);
    const forwarded = await h.request('POST', initialize);
    expect(authorization).toBe(`Bearer ${secret}`);
    expect([...forwarded.response.headers.keys()]).not.toContain('x-private');
    expect(await forwarded.response.text()).not.toContain(secret);
  });

  it('uses the actual prompting principal OAuth grant for a shared session', async () => {
    let authorization: string | undefined;
    const url = await listen((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const h = await harness({
      server: {
        transport: 'http',
        url: `${url}/mcp`,
        auth: { type: 'oauth', oauth_mode: 'per_user' },
      },
      separatePrincipal: true,
      branchRbacEnabled: true,
      oauthAccessToken: 'prompt-caller-oauth-token',
    });

    expect(h.oauthTokenUserId).toBe(h.principal.user_id);
    expect(h.oauthTokenUserId).not.toBe(h.user.user_id);
    await expect(h.request('POST', initialize)).resolves.toBeDefined();
    expect(authorization).toBe('Bearer prompt-caller-oauth-token');
  });

  it('rejects GET before provider dispatch', async () => {
    let providerRequests = 0;
    const url = await listen((_request, response) => {
      providerRequests += 1;
      response.end();
    });
    const h = await harness({ server: { transport: 'http', url, auth: { type: 'none' } } });
    await expect(h.request('GET')).rejects.toMatchObject({
      status: 405,
      code: 'method_not_mediated',
    });
    expect(providerRequests).toBe(0);
  });

  it('reconstructs SSE from validated JSON data only and drops every control field', async () => {
    const secret = 'sse-control-secret-value';
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `: ${secret}\nid: ${secret}\nevent: ${secret}\nretry: 1000\ndata: {"jsonrpc":"2.0","id":1,"result":"safe"}\n\n`
      );
    });
    const h = await harness({
      server: { transport: 'http', url, auth: { type: 'bearer', token: secret } },
    });
    const text = await (await h.request('POST', initialize)).response.text();
    expect(text).toBe('data: {"jsonrpc":"2.0","id":1,"result":"safe"}\n\n');
    expect(text).not.toContain(secret);
  });

  it('bounds concurrent response memory and sockets per task', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let providerRequests = 0;
    const url = await listen(async (_request, response) => {
      providerRequests += 1;
      await gate;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const h = await harness({ server: { transport: 'http', url, auth: { type: 'none' } } });
    const held = Array.from({ length: 4 }, () => h.request('POST', initialize));
    await vi.waitFor(() => expect(providerRequests).toBe(4));
    expect(h.gateway.status('default')).toMatchObject({
      inFlightRequests: 4,
      activeRequests: 4,
      providerInFlightRequests: 4,
      reservedRequests: 0,
    });
    await expect(h.request('POST', initialize)).rejects.toMatchObject({
      status: 429,
      code: 'egress_capacity_exceeded',
    });
    release();
    await Promise.all(held);
  });

  it('aborts only the tenant whose rollout changed', () => {
    const gateway = new MCPEgressGateway({
      db: {} as TenantScopeAwareDatabase,
      app: {} as Application,
      jwtSecret: 'tenant-abort-test',
      branchRbacEnabled: false,
    });
    const tenantA = new AbortController();
    const tenantB = new AbortController();
    const reservations = (
      gateway as unknown as {
        reservations: Map<
          string,
          {
            tenantId: string;
            taskId: string;
            serverId: string;
            controller: AbortController;
            startedAt: number;
          }
        >;
      }
    ).reservations;
    reservations.set('tenant-a-request', {
      tenantId: 'tenant-a',
      taskId: 'task-a',
      serverId: 'server-a',
      controller: tenantA,
      startedAt: Date.now(),
    });
    reservations.set('tenant-b-request', {
      tenantId: 'tenant-b',
      taskId: 'task-b',
      serverId: 'server-b',
      controller: tenantB,
      startedAt: Date.now(),
    });

    expect(gateway.abortTenant('tenant-a')).toBe(1);
    expect(tenantA.signal.aborted).toBe(true);
    expect(tenantA.signal.reason).toBeInstanceOf(MCPEgressGatewayError);
    expect(tenantA.signal.reason).toMatchObject({ code: 'rollout_changed', status: 409 });
    expect(tenantB.signal.aborted).toBe(false);
  });

  it('uses one durable material identity across OAuth hook enrichment and routine refresh', () => {
    const base = {
      mcp_server_id: 'oauth-material',
      config_version: 4,
      transport: 'http',
      url: 'https://provider.example/mcp',
      auth: { type: 'oauth', oauth_client_id: 'durable-client' },
    } as MCPServer;
    const enriched = {
      ...base,
      auth: {
        ...base.auth,
        oauth_access_token: 'routine-access-token',
        oauth_refresh_token: 'routine-refresh-token',
        oauth_token_expires_at: Date.now() + 60_000,
      },
    } as MCPServer;
    expect(mcpEgressMaterialHash(enriched, {}, 'hash-key')).toBe(
      mcpEgressMaterialHash(base, {}, 'hash-key')
    );
    const helperServer = {
      ...base,
      url: 'https://provider.example/{{uppercase (default user.env.TENANT user.env.FALLBACK)}}',
    } as MCPServer;
    expect(
      mcpEgressMaterialHash(
        helperServer,
        { TENANT: 'secret-before', FALLBACK: 'fallback' },
        'hash-key'
      )
    ).not.toBe(
      mcpEgressMaterialHash(
        helperServer,
        { TENANT: 'secret-after', FALLBACK: 'fallback' },
        'hash-key'
      )
    );
  });

  it('admits the first request from an OAuth token-and-expiry-enriched projection', async () => {
    const provider = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const h = await harness({
      server: {
        transport: 'http',
        url: provider,
        auth: { type: 'oauth', oauth_client_id: 'durable-client' },
      },
      capabilityServerTransform: (server) => ({
        ...server,
        auth: {
          ...server.auth!,
          oauth_access_token: 'hook-enriched-live-token',
          oauth_token_expires_at: Date.now() + 3_600_000,
        },
      }),
    });

    await expect(h.request('POST', initialize)).resolves.toBeDefined();
  });

  it.each([
    { mutation: 'task completion', oauthMode: 'per_user' },
    { mutation: 'session detach', oauthMode: 'per_user' },
    { mutation: 'server mutation', oauthMode: 'per_user' },
    { mutation: 'tenant rollout', oauthMode: 'per_user' },
    { mutation: 'tenant rollout', oauthMode: 'shared' },
    { mutation: 'shutdown', oauthMode: 'per_user' },
  ] as const)(
    'rechecks $mutation after refresh DNS for a $oauthMode grant without quarantining it',
    async ({ mutation, oauthMode }) => {
      let tokenRequests = 0;
      const tokenUrl = asLocalhost(
        await listen((_request, response) => {
          tokenRequests += 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"access_token":"refreshed-access-token","expires_in":3600}');
        })
      );
      const mcpUrl = await listen((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
      let dnsStarted!: () => void;
      let releaseDns!: () => void;
      const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
      const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
      const h = await harness({
        server: {
          transport: 'http',
          scope: 'session',
          url: mcpUrl,
          auth: {
            type: 'oauth',
            oauth_mode: oauthMode,
            oauth_client_id: 'durable-client-id',
            oauth_token_url: tokenUrl,
          },
        },
        oauthAccessToken: 'prior-valid-access-token',
        oauthRefreshToken: 'refresh-secret-never-sent-stale',
        oauthExpiresAt: new Date(0),
        oauthAuthHeadersCreate: async (params) => {
          const observed = await new UserMCPOAuthTokenRepository(h.rawDb).getToken(
            h.oauthTokenUserId,
            h.server.mcp_server_id
          );
          if (!observed) throw new Error('Expected OAuth grant');
          const token = await refreshAndPersistToken({
            db: h.rawDb,
            userId: h.oauthTokenUserId,
            mcpServerId: h.server.mcp_server_id,
            observedRefreshVersion: {
              grantGeneration: observed.grant_generation,
              grantBindingFingerprint: observed.grant_binding_fingerprint,
              refreshGeneration: observed.refresh_generation,
            },
            validateGrant: async () => true,
            allowLocalhostHttpDevelopment: true,
            resolveDns: async () => {
              dnsStarted();
              await dnsGate;
              return [{ address: '127.0.0.1', family: 4 }];
            },
            assertCurrent: params.mcp_egress_assert_current,
          });
          return {
            headers: {
              [h.server.mcp_server_id]: { authorization: `Bearer ${token}` },
            },
          };
        },
      });

      // Exercise the production Express handler so the stable structured
      // reason is proven at the executor-visible route boundary.
      const pending = h.routeRequest('POST', initialize);
      await dnsObserved;
      await new Promise((resolve) => setTimeout(resolve, 2));
      const reservedStatus = h.gateway.status('default');
      expect(reservedStatus).toMatchObject({
        inFlightRequests: 1,
        activeRequests: 1,
        providerInFlightRequests: 0,
        reservedRequests: 1,
      });
      expect(reservedStatus.oldestRequestMs).toBeGreaterThan(0);
      if (mutation === 'task completion') {
        await new TaskRepository(h.rawDb).update(h.task.task_id, {
          status: TaskStatus.COMPLETED,
        });
      } else if (mutation === 'session detach') {
        await coordinateSessionMCPRevocation({
          db: h.rawDb,
          gateway: h.gateway,
          tenantId: 'default',
          serverIds: [h.server.mcp_server_id],
          mutate: () =>
            new SessionMCPServerRepository(h.rawDb).removeServer(
              h.session.session_id,
              h.server.mcp_server_id
            ),
        });
      } else if (mutation === 'server mutation') {
        const updated = await new MCPServerRepository(h.rawDb).update(h.server.mcp_server_id, {
          description: 'changed while refresh DNS was held',
          expected_config_version: h.server.config_version,
        });
        coordinateMCPServerMutationAfterWrite(
          { params: { tenant: { tenant_id: 'default' } }, result: updated } as never,
          h.gateway
        );
      } else if (mutation === 'tenant rollout') {
        await coordinateMCPEgressRolloutChange({
          gateway: h.gateway,
          tenantId: 'default',
          mutate: () => setMCPEgressGatewayMode(h.rawDb, 'off', h.user.user_id),
        });
      } else {
        h.gateway.close();
      }
      releaseDns();

      const expectedCode =
        mutation === 'task completion'
          ? 'principal_revoked'
          : mutation === 'session detach'
            ? 'server_detached'
            : mutation === 'server mutation'
              ? 'stale_capability'
              : mutation === 'tenant rollout'
                ? 'rollout_changed'
                : 'egress_unavailable';
      const routeResponse = await pending;
      expect(routeResponse).toMatchObject({
        status:
          expectedCode === 'principal_revoked' || expectedCode === 'server_detached'
            ? 403
            : expectedCode === 'egress_unavailable'
              ? 503
              : 409,
      });
      expect(routeResponse.payload).toMatchObject({ error: { data: { code: expectedCode } } });
      expect(tokenRequests).toBe(0);
      const retained = await new UserMCPOAuthTokenRepository(h.rawDb).getToken(
        h.oauthTokenUserId,
        h.server.mcp_server_id
      );
      expect(retained).toMatchObject({
        oauth_access_token: 'prior-valid-access-token',
        oauth_refresh_token: 'refresh-secret-never-sent-stale',
        refresh_status: 'idle',
        refresh_generation: 0,
        refresh_success_generation: 0,
      });
      expect(retained?.refresh_claim_id).toBeUndefined();
      expect(retained?.refresh_claimed_at).toBeUndefined();
    }
  );

  it('prefers the durable authority reason over a mismatched local abort accelerator', async () => {
    let providerRequests = 0;
    const url = asLocalhost(
      await listen((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    let dnsStarted!: () => void;
    let releaseDns!: () => void;
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const h = await harness({
      server: { transport: 'http', url, auth: { type: 'none' } },
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });

    const pending = h.routeRequest('POST', initialize);
    await dnsObserved;
    await new MCPServerRepository(h.rawDb).update(h.server.mcp_server_id, {
      description: 'durable config mutation must win',
      expected_config_version: h.server.config_version,
    });
    // Deliberately use the other closed accelerator reason. The route must
    // still report the current durable config-version failure.
    h.gateway.abortServer('default', h.server.mcp_server_id, 'server_detached');
    releaseDns();

    await expect(pending).resolves.toMatchObject({
      status: 409,
      payload: { error: { data: { code: 'stale_capability' } } },
    });
    expect(providerRequests).toBe(0);
  });

  it('fails closed for every stdio server without spawning or writing a process', async () => {
    const marker = `/tmp/mcp-egress-stdio-${randomUUID()}`;
    const h = await harness({
      server: {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        env: { MCP_SECRET: 'stdio-secret-never-exported' },
      },
    });

    await expect(h.request('POST', initialize)).rejects.toMatchObject({
      code: 'transport_not_mediated',
    });
    await expect(import('node:fs/promises').then(({ access }) => access(marker))).rejects.toThrow();
  });

  it('scans decoded JSON and URL-path credential material but ignores low-entropy DEBUG values', async () => {
    const pathSecret = 'path-secret-9f8c7b6a';
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `escaped:${pathSecret}` }));
    });
    const h = await harness({
      server: {
        transport: 'http',
        url: `${url}/mcp/${pathSecret}`,
        auth: { type: 'none' },
        env: { DEBUG: '1' },
      },
    });
    await expect(h.request('POST', initialize)).rejects.toMatchObject({
      code: 'credential_reflection_blocked',
    });

    const harmlessUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":"DEBUG=1 initialize"}');
    });
    const harmless = await harness({
      server: {
        transport: 'http',
        url: `${harmlessUrl}/initialize`,
        auth: { type: 'none' },
        env: { DEBUG: '1' },
      },
    });
    await expect(
      (await harmless.request('POST', initialize)).response.json()
    ).resolves.toMatchObject({
      result: 'DEBUG=1 initialize',
    });
  });

  it('uses a second SQLite connection to prove a commit before final admission prevents provider observation', async () => {
    const file = `/tmp/mcp-egress-race-${randomUUID()}.db`;
    files.push(file);
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let providerRequests = 0;
    const provider = asLocalhost(
      await listen((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    const h = await harness({
      dbUrl: `file:${file}`,
      server: {
        transport: 'http',
        url: `${provider}/mcp`,
        auth: { type: 'bearer', token: 'cross-connection-secret' },
      },
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const dbB = await createDatabaseAsync({ dialect: 'sqlite', url: `file:${file}` });
    databases.push(dbB as typeof dbB & { $client?: { close?: () => void } });

    const pending = h.request('POST', initialize);
    await dnsObserved;
    await new MCPServerRepository(dbB).update(h.server.mcp_server_id, {
      description: 'committed by daemon B',
      expected_config_version: h.server.config_version,
    });
    releaseDns();

    await expect(pending).rejects.toMatchObject({ code: 'stale_capability' });
    expect(providerRequests).toBe(0);
  });

  it('holds one SQLite authority snapshot across config/detach/reattach constituent reads', async () => {
    const file = `/tmp/mcp-egress-snapshot-${randomUUID()}.db`;
    files.push(file);
    let checkpointCount = 0;
    let releaseSnapshot!: () => void;
    let finalSnapshotStarted!: () => void;
    const snapshotGate = new Promise<void>((resolve) => (releaseSnapshot = resolve));
    const snapshotObserved = new Promise<void>((resolve) => (finalSnapshotStarted = resolve));
    let providerRequests = 0;
    const url = await listen((_request, response) => {
      providerRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const h = await harness({
      dbUrl: `file:${file}`,
      server: { transport: 'http', url, scope: 'session', auth: { type: 'none' } },
      authoritySnapshotCheckpoint: async () => {
        checkpointCount += 1;
        if (checkpointCount === 2) {
          finalSnapshotStarted();
          await snapshotGate;
        }
      },
    });
    const dbB = await createDatabaseAsync({ dialect: 'sqlite', url: `file:${file}` });
    databases.push(dbB as typeof dbB & { $client?: { close?: () => void } });
    const pending = h.request('POST', initialize);
    await snapshotObserved;
    const mutate = () =>
      runWithTenantDatabaseTransaction(dbB, undefined, async (tx) => {
        await new SessionMCPServerRepository(tx).removeServer(
          h.session.session_id,
          h.server.mcp_server_id
        );
        await new MCPServerRepository(tx).update(h.server.mcp_server_id, {
          description: 'atomic mixed-read adversary',
          expected_config_version: h.server.config_version,
        });
        await new SessionMCPServerRepository(tx).addServer(
          h.session.session_id,
          h.server.mcp_server_id
        );
      });
    const contendingMutation = expect(mutate()).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    await contendingMutation;
    releaseSnapshot();
    await expect(pending).resolves.toBeDefined();
    await new MCPServerRepository(dbB).update(h.server.mcp_server_id, {
      description: 'committed after the admitted snapshot',
      expected_config_version: h.server.config_version,
    });
    expect(providerRequests).toBe(1);
    await expect(h.request('POST', initialize)).rejects.toMatchObject({ code: 'stale_capability' });
  });

  it('truthfully allows an already-admitted cross-daemon request to complete after a commit', async () => {
    const file = `/tmp/mcp-egress-admitted-${randomUUID()}.db`;
    files.push(file);
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
    const providerObserved = new Promise<void>((resolve) => (providerStarted = resolve));
    let providerRequests = 0;
    const url = await listen(async (_request, response) => {
      providerRequests += 1;
      providerStarted();
      await providerGate;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{"admitted":true}}');
    });
    const h = await harness({
      dbUrl: `file:${file}`,
      server: { transport: 'http', url, auth: { type: 'bearer', token: 'admitted-secret' } },
    });
    const dbB = await createDatabaseAsync({ dialect: 'sqlite', url: `file:${file}` });
    databases.push(dbB as typeof dbB & { $client?: { close?: () => void } });

    const pending = h.request('POST', initialize);
    await providerObserved;
    await new MCPServerRepository(dbB).update(h.server.mcp_server_id, {
      description: 'commit after provider observation',
      expected_config_version: h.server.config_version,
    });
    releaseProvider();

    await expect((await pending).response.json()).resolves.toMatchObject({
      result: { admitted: true },
    });
    expect(providerRequests).toBe(1);
    await expect(h.request('POST', initialize)).rejects.toMatchObject({ code: 'stale_capability' });
  });

  it('never follows provider redirects for mediated methods', async () => {
    let targetRequests = 0;
    const base = await listen((request, response) => {
      if (request.url === '/target') {
        targetRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
        return;
      }
      response.writeHead(302, { location: '/target' });
      response.end();
    });
    const h = await harness({
      server: { transport: 'http', url: `${base}/source`, auth: { type: 'none' } },
    });
    await expect(h.request('POST', initialize)).rejects.toThrow('redirect');
    expect(targetRequests).toBe(0);
  });

  it('rechecks session attachment immediately before provider send', async () => {
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let providerRequests = 0;
    const provider = asLocalhost(
      await listen((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    const h = await harness({
      server: { transport: 'http', url: provider, scope: 'session', auth: { type: 'none' } },
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const pending = h.request('POST', initialize);
    await dnsObserved;
    await new SessionMCPServerRepository(h.rawDb).removeServer(
      h.session.session_id,
      h.server.mcp_server_id
    );
    releaseDns();
    await expect(pending).rejects.toMatchObject({ code: 'server_detached' });
    expect(providerRequests).toBe(0);
  });

  it('rechecks branch ACL for a collaborating principal immediately before provider send', async () => {
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let providerRequests = 0;
    const provider = asLocalhost(
      await listen((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    const h = await harness({
      server: { transport: 'http', url: provider, auth: { type: 'none' } },
      separatePrincipal: true,
      branchRbacEnabled: true,
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const pending = h.request('POST', initialize);
    await dnsObserved;
    const policies = new CapabilityPolicyRepository(h.rawDb);
    const current = await policies.getBranchPolicy(h.branch.branch_id);
    const config = structuredClone(current.override_config!);
    config.allow_shared_session_prompts = false;
    await policies.replaceBranchPolicy(
      h.branch.branch_id,
      { ...current, override_config: config },
      h.user.user_id
    );
    releaseDns();

    await expect(pending).rejects.toMatchObject({ code: 'branch_revoked' });
    expect(providerRequests).toBe(0);
  });

  it('coordinates OAuth grant deletion at final send while routine token rotation preserves grant identity', async () => {
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let providerRequests = 0;
    const provider = asLocalhost(
      await listen((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    const h = await harness({
      server: { transport: 'http', url: provider, auth: { type: 'oauth', oauth_mode: 'per_user' } },
      oauthAccessToken: 'oauth-token-before-refresh',
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const tokens = new UserMCPOAuthTokenRepository(h.rawDb);
    const pending = h.request('POST', initialize);
    await dnsObserved;
    await tokens.deleteToken(h.user.user_id as UserID, h.server.mcp_server_id as MCPServerID);
    releaseDns();
    await expect(pending).rejects.toMatchObject({ code: 'grant_changed' });
    expect(providerRequests).toBe(0);

    const rotated = await harness({
      server: {
        transport: 'http',
        url: provider.replace('localhost', '127.0.0.1'),
        auth: { type: 'oauth', oauth_mode: 'per_user' },
      },
      oauthAccessToken: 'oauth-token-old-value',
    });
    await new UserMCPOAuthTokenRepository(rotated.rawDb).saveToken(
      rotated.user.user_id as UserID,
      rotated.server.mcp_server_id,
      { accessToken: 'oauth-token-routinely-refreshed' }
    );
    await expect(rotated.request('POST', initialize)).resolves.toBeDefined();
    expect(providerRequests).toBe(1);

    await new UserMCPOAuthTokenRepository(rotated.rawDb).saveToken(
      rotated.user.user_id as UserID,
      rotated.server.mcp_server_id,
      {
        accessToken: 'replacement-grant-token',
        clientId: 'replacement-client',
        grantBinding: {
          generation: 2,
          version: 4,
          fingerprint: 'gateway-test-binding-v2',
          metadataUri: 'https://auth.example.test/.well-known/oauth-protected-resource',
          resourceUri: rotated.server.url!,
          issuer: 'https://auth.example.test',
          authorizationEndpoint: 'https://auth.example.test/authorize',
          tokenEndpoint: 'https://auth.example.test/token',
          redirectUri: 'https://daemon.example.test/mcp-servers/oauth-callback',
        },
      }
    );
    await expect(rotated.request('POST', initialize)).rejects.toMatchObject({
      code: 'grant_changed',
    });
    expect(providerRequests).toBe(1);
  });

  it('revalidates authority immediately before JWT minting and never exports JWT client secrets', async () => {
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let mintRequests = 0;
    let mcpRequests = 0;
    const mintUrl = asLocalhost(
      await listen((_request, response) => {
        mintRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"access_token":"minted-provider-jwt"}');
      })
    );
    const mcpUrl = asLocalhost(
      await listen((_request, response) => {
        mcpRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      })
    );
    const h = await harness({
      server: {
        transport: 'http',
        url: mcpUrl,
        auth: {
          type: 'jwt',
          api_url: mintUrl,
          api_token: 'jwt-client-name',
          api_secret: 'jwt-client-secret-never-exported',
        },
      },
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const pending = h.request('POST', initialize);
    await dnsObserved;
    await new MCPServerRepository(h.rawDb).update(h.server.mcp_server_id, {
      description: 'JWT authority revoked before mint dispatch',
      expected_config_version: h.server.config_version,
    });
    releaseDns();

    await expect(pending).rejects.toMatchObject({ code: 'stale_capability' });
    expect(mintRequests).toBe(0);
    expect(mcpRequests).toBe(0);
    expect(h.capability).not.toContain('jwt-client-secret-never-exported');
  });

  it('enforces task lifetime and tool policy before provider send', async () => {
    let providerRequests = 0;
    const url = await listen((_request, response) => {
      providerRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const denied = await harness({
      server: {
        transport: 'http',
        url,
        auth: { type: 'none' },
        tool_permissions: { 'dangerous.write': 'deny' },
      },
    });
    await expect(
      denied.request(
        'POST',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'dangerous.write', arguments: {} },
        })
      )
    ).rejects.toMatchObject({ code: 'tool_denied' });

    const ended = await harness({
      server: { transport: 'http', url, auth: { type: 'none' } },
    });
    await new TaskRepository(ended.rawDb).update(ended.task.task_id, {
      status: TaskStatus.COMPLETED,
    });
    await expect(ended.request('POST', initialize)).rejects.toMatchObject({
      code: 'principal_revoked',
    });

    const demoted = await harness({
      server: { transport: 'http', url, auth: { type: 'none' } },
    });
    await new UsersRepository(demoted.rawDb).update(demoted.user.user_id, { role: 'viewer' });
    await expect(demoted.request('POST', initialize)).rejects.toMatchObject({
      code: 'principal_revoked',
    });
    expect(providerRequests).toBe(0);
  });
});

describe.runIf(process.env.AGOR_RUN_MCP_EGRESS_BENCHMARK === '1')(
  'MCP egress SQLite admission benchmark',
  () => {
    it('reports the durable no-send authority check on an explicitly quiet host', async () => {
      const h = await harness({
        server: {
          transport: 'http',
          url: 'https://provider.example/mcp',
          auth: { type: 'bearer', token: 'benchmark-provider-secret' },
        },
      });
      for (let index = 0; index < 20; index += 1) {
        await h.gateway.checkAdmission(h.capability, h.server.mcp_server_id);
      }
      const samples: number[] = [];
      for (let index = 0; index < 200; index += 1) {
        const started = performance.now();
        await h.gateway.checkAdmission(h.capability, h.server.mcp_server_id);
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      const percentile = (value: number) => samples[Math.ceil(samples.length * value) - 1]!;
      const result = {
        samples: samples.length,
        p50_ms: Number(percentile(0.5).toFixed(3)),
        p95_ms: Number(percentile(0.95).toFixed(3)),
        p99_ms: Number(percentile(0.99).toFixed(3)),
      };
      console.info(`MCP_EGRESS_SQLITE_ADMISSION_BENCHMARK ${JSON.stringify(result)}`);
      // Host scheduling dominates small local samples. The opt-in result is
      // evidence to compare with a quiet-host baseline, not a CI release gate
      // and not evidence for PostgreSQL/HA availability.
      expect(result.samples).toBe(200);
    });
  }
);
