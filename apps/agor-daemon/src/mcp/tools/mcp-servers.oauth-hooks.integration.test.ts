import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { MCPServerID, UserID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpEgressMaterialHash } from '../../mcp-egress/gateway.js';
import { type RegisterHooksContext, registerHooks } from '../../register-hooks.js';
import {
  fingerprintMCPOAuthGrantConfiguration,
  isMCPOAuthGrantBoundToServer,
  type MCPOAuthResolvedGrantBinding,
} from '../../services/mcp-oauth-grant-binding.js';
import { createMCPServersService } from '../../services/mcp-servers.js';
import { listAttachedMcpServers, registerMcpServerTools } from './mcp-servers.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

describe('MCP OAuth status through Feathers response hooks', () => {
  let previousMasterSecret: string | undefined;
  let rawDb: Awaited<ReturnType<typeof createDatabaseAsync>> | undefined;

  beforeEach(() => {
    previousMasterSecret = process.env.AGOR_MASTER_SECRET;
    process.env.AGOR_MASTER_SECRET = 'b'.repeat(64);
  });

  afterEach(() => {
    (rawDb as unknown as { $client?: { close(): void } } | undefined)?.$client?.close();
    rawDb = undefined;
    if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
    else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
  });

  it('reports a valid v4 grant in list, auth status, and attached summaries', async () => {
    rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(rawDb);
    const db = rawDb as unknown as TenantScopeAwareDatabase;
    const user = await new UsersRepository(rawDb).create({
      email: 'mcp-hook-oauth@example.com',
      role: 'member',
    });
    const server = await new MCPServerRepository(rawDb).create({
      name: 'mcp-hook-oauth',
      display_name: 'MCP Hook OAuth',
      transport: 'http',
      url: 'https://resource.example.test/mcp',
      scope: 'global',
      source: 'user',
      owner_user_id: user.user_id as UserID,
      enabled: true,
      headers: { 'X-Route': 'configured-route' },
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_compatibility_mode: 'strict',
        oauth_client_id: 'configured-client',
        oauth_client_secret: 'configured-client-secret',
        oauth_access_token: 'configured-static-access',
        oauth_refresh_token: 'configured-static-refresh',
        oauth_token_expires_at: Date.now() + 7_200_000,
      },
    });
    const resolved = {
      resourceUri: server.url!,
      metadataUrl: 'https://resource.example.test/.well-known/oauth-protected-resource',
      issuer: 'https://auth.example.test',
      authorizationEndpoint: 'https://auth.example.test/authorize',
      tokenEndpoint: 'https://auth.example.test/token',
      redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
      clientId: 'configured-client',
      clientSecret: 'configured-client-secret',
      compatibilityMode: 'strict',
    } satisfies MCPOAuthResolvedGrantBinding;
    const fingerprint = fingerprintMCPOAuthGrantConfiguration(
      process.env.AGOR_MASTER_SECRET!,
      server,
      resolved,
      4
    );
    await new UserMCPOAuthTokenRepository(rawDb).saveToken(
      user.user_id as UserID,
      server.mcp_server_id as MCPServerID,
      {
        accessToken: 'durable-grant-access',
        refreshToken: 'durable-grant-refresh',
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        expiresAt: new Date(Date.now() + 3_600_000),
        grantBinding: {
          generation: 1,
          version: 4,
          fingerprint,
          metadataUri: resolved.metadataUrl,
          resourceUri: resolved.resourceUri,
          issuer: resolved.issuer,
          authorizationEndpoint: resolved.authorizationEndpoint,
          tokenEndpoint: resolved.tokenEndpoint,
          redirectUri: resolved.redirectUri,
        },
      }
    );
    const savedGrant = await new UserMCPOAuthTokenRepository(rawDb).getToken(
      user.user_id as UserID,
      server.mcp_server_id as MCPServerID
    );
    const savedServer = await new MCPServerRepository(rawDb).findById(server.mcp_server_id);
    expect(savedGrant).not.toBeNull();
    expect(savedServer).not.toBeNull();
    expect(
      isMCPOAuthGrantBoundToServer(
        process.env.AGOR_MASTER_SECRET!,
        savedServer!,
        savedGrant!,
        'strict'
      )
    ).toBe(true);

    const app = feathers() as Application;
    (app as Application & { publish: (publisher: unknown) => Application }).publish = () => app;
    app.use('mcp-servers', createMCPServersService(db));
    const placeholderService = () => ({
      async find() {
        return [];
      },
      async get() {
        return {};
      },
      async create(data: unknown) {
        return data;
      },
      async update(_id: unknown, data: unknown) {
        return data;
      },
      async patch(_id: unknown, data: unknown) {
        return data;
      },
      async remove() {
        return {};
      },
    });
    // `registerHooks` wires the whole daemon and has a few intentionally
    // mandatory services. They are inert here; only mcp-servers is exercised.
    for (const path of [
      'users',
      'messages',
      'repos',
      'branches',
      'sessions',
      'leaderboard',
      'schedules',
      'tasks',
    ]) {
      app.use(path, placeholderService() as never);
    }
    registerHooks({
      db,
      app,
      config: {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'default' },
        execution: { branch_rbac: false, unix_user_mode: 'simple' },
      } as RegisterHooksContext['config'],
      jwtSecret: 'mcp-hook-integration-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: false },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' } as RegisterHooksContext['deployment'],
    });

    const sessionId = '00000000-0000-7000-8000-000000000123';
    app.use('session-mcp-servers', {
      async find() {
        return {
          total: 1,
          limit: 100,
          skip: 0,
          data: [{ mcp_server_id: server.mcp_server_id, enabled: true }],
        };
      },
    } as never);

    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user,
      tenant: { tenant_id: 'default', source: 'static' },
    } as const;
    const context = {
      app,
      db,
      userId: user.user_id as UserID,
      sessionId,
      authenticatedUser: user,
      baseServiceParams,
    };

    // Generic reads never hydrate the per-user grant. External reads retain
    // the existing secret-redaction boundary.
    const projected = await app
      .service('mcp-servers')
      .get(server.mcp_server_id, baseServiceParams as never);
    expect(projected.auth?.oauth_access_token).toBe(MCP_HEADER_REDACTED_SENTINEL);
    expect(JSON.stringify(projected)).not.toContain('configured-client-secret');
    expect(JSON.stringify(projected)).not.toContain('durable-grant-access');

    const executorProjected = await app.service('mcp-servers').get(server.mcp_server_id, {
      authenticated: true,
      provider: undefined,
      query: { forUserId: user.user_id },
      user: { ...user, role: 'service', _isServiceAccount: true },
      authentication: { payload: { type: 'internal' } },
      tenant: { tenant_id: 'default', source: 'static' },
    } as never);
    // Trusted in-process reads retain their existing access to credentials
    // stored on the server row, but must not receive the user's durable grant.
    expect(executorProjected.auth?.oauth_access_token).toBe('configured-static-access');
    expect(executorProjected.auth?.oauth_access_token).not.toBe('durable-grant-access');
    expect(executorProjected.auth?.oauth_token_expires_at).toBe(
      server.auth?.oauth_token_expires_at
    );
    expect(mcpEgressMaterialHash(executorProjected, {}, 'projection-hash-key')).toBe(
      mcpEgressMaterialHash(savedServer!, {}, 'projection-hash-key')
    );

    const handlers = new Map<string, ToolHandler>();
    const mcp = {
      registerTool(name: string, _config: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerMcpServerTools(mcp, context as never);

    const listResult = await handlers.get('agor_mcp_servers_list')!({});
    const listed = JSON.parse(listResult.content[0]!.text) as {
      mcp_servers: Array<{ mcp_server_id: string; oauth_authenticated: boolean }>;
    };
    expect(listed.mcp_servers).toContainEqual(
      expect.objectContaining({
        mcp_server_id: server.mcp_server_id,
        oauth_authenticated: true,
      })
    );

    const statusResult = await handlers.get('agor_mcp_servers_auth_status')!({
      mcpServerId: server.mcp_server_id,
    });
    expect(JSON.parse(statusResult.content[0]!.text)).toMatchObject({
      mcp_server_id: server.mcp_server_id,
      oauth_authenticated: true,
    });

    const attachedContext = {
      ...context,
      app: {
        service(path: string) {
          if (path === 'sessions') {
            return { get: async () => ({ session_id: sessionId, created_by: user.user_id }) };
          }
          return app.service(path);
        },
      },
    };
    await expect(
      listAttachedMcpServers(attachedContext as never, sessionId)
    ).resolves.toContainEqual(
      expect.objectContaining({
        mcp_server_id: server.mcp_server_id,
        oauth_authenticated: true,
      })
    );
  });
});
