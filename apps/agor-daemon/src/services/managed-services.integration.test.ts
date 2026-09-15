/** Registered HTTP boundaries with the real production composition, never a fake managed service. */

import type { Server } from 'node:http';
import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { ExpressApplication } from '@agor/core/feathers';
import {
  errorHandler,
  feathers,
  feathersExpress,
  NotAuthenticated,
  rest,
} from '@agor/core/feathers';
import type { HookContext, MCPServer, UserID } from '@agor/core/types';
import { json } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegisteredMCPCatalogConnectService } from '../register-routes.js';
import { type RegisterServicesContext, registerMCPServices } from '../register-services.js';
import { createManagedOAuthServices } from './mcp-oauth-managed-composition.js';

const userId = '01900000-0000-7000-8000-000000000001' as UserID;
const auth = 'synthetic-http-test-session';

describe('registered managed service surfaces with production default-off composition', () => {
  let db: Awaited<ReturnType<typeof createDatabaseAsync>>;
  let listener: Server;
  let base: string;
  let managedRow: MCPServer;
  let app: ExpressApplication;
  beforeAll(async () => {
    db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(db);
    await new UsersRepository(db).create({
      user_id: userId,
      email: 'registered@example.test',
      role: 'admin',
    });
    const services = await createManagedOAuthServices({
      db: db as unknown as TenantScopeAwareDatabase,
      config: {},
      releaseSha: 'dev',
      replicaId: 'test-only',
      externalLaunchProvider: { enabled: false } as Parameters<
        typeof createManagedOAuthServices
      >[0]['externalLaunchProvider'],
    });
    expect(services).toBeNull();
    app = feathersExpress(feathers());
    app.use(json());
    app.configure(rest());
    const requireAuth = async (context: HookContext) => {
      if (context.params.headers?.authorization !== `Bearer ${auth}`) throw new NotAuthenticated();
      context.params.user = { user_id: userId, role: 'admin' } as never;
      context.params.tenant = { tenant_id: 'default', source: 'static' } as never;
      return context;
    };
    await registerMCPServices({
      db: db as unknown as TenantScopeAwareDatabase,
      app: app as never,
      config: {},
      jwtSecret: 'synthetic-jwt-test',
      daemonUrl: 'http://127.0.0.1:3030',
      bundledUiAvailable: false,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      requireAuth,
      deployment: {} as RegisterServicesContext['deployment'],
      mcpOAuthCallbackUrl: 'http://127.0.0.1:3030/mcp-servers/oauth-callback',
      mcpManagedOAuthServices: services ?? undefined,
      mcpManagedOAuthRuntime: services?.runtime,
    });
    app.use(
      '/mcp-catalog/connect',
      createRegisteredMCPCatalogConnectService(
        app as never,
        db as unknown as TenantScopeAwareDatabase,
        services ?? undefined
      ),
      { methods: ['create'] }
    );
    app.service('mcp-catalog/connect').hooks({ before: { create: [requireAuth] } });
    app.service('mcp-catalog/readiness').hooks({ before: { get: [requireAuth] } });
    app.use(errorHandler());
    managedRow = await new MCPServerRepository(db).create({
      name: 'managed-off',
      transport: 'http',
      url: 'https://never-contact.invalid/mcp',
      scope: 'global',
      enabled: true,
      source: 'user',
      owner_user_id: userId,
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_client_mode: 'cloud_managed_v1',
        oauth_managed_profile: {
          profile_id: 'synthetic',
          semantic_version: '1',
          environment: 'staging',
          region: 'us-west-2',
          registry_digest: 'a'.repeat(64),
        },
      },
    });
    listener = (await app.listen(0, '127.0.0.1')) as Server;
    if (!listener.listening)
      await new Promise<void>((resolve, reject) => {
        listener.once('listening', resolve);
        listener.once('error', reject);
      });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
  }, 30000);
  afterAll(async () => {
    await app?.teardown();
    if (listener?.listening)
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    (db as unknown as { $client?: { close(): void } })?.$client?.close();
  });
  const post = async (path: string, body: unknown, authenticated = true) => {
    const response = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        ...(authenticated ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  it('refuses managed return without authentication and never treats a ticket as success', async () => {
    const body = {
      transaction_id: 'fake-transaction',
      ticket: 'T'.repeat(43),
      client_nonce: 'N'.repeat(43),
    };
    expect((await post('mcp-servers/oauth-managed-return', body, false)).status).toBe(401);
    const result = await post('mcp-servers/oauth-managed-return', body);
    expect(result.status).toBe(403);
    expect(result.body).not.toHaveProperty('accepted');
  });
  it('never falls back to direct OAuth start for a saved managed row', async () => {
    const result = await post('mcp-servers/oauth-start', {
      mcp_server_id: managedRow.mcp_server_id,
      client_nonce: 'N'.repeat(43),
    });
    expect(result.body.success).not.toBe(true);
    expect(result.body).not.toHaveProperty('authorizationUrl');
    expect(JSON.stringify(result.body)).not.toContain('getaddrinfo');
  });
  it('never exposes a public bearer or attempts unmediated managed discovery', async () => {
    const headers = await post('mcp-servers/oauth-auth-headers', {
      mcp_server_ids: [managedRow.mcp_server_id],
    });
    expect(headers.status).toBe(403);
    const discovered = await post('mcp-servers/discover', {
      mcp_server_id: managedRow.mcp_server_id,
    });
    expect(discovered.body.success).toBe(false);
    expect(JSON.stringify(discovered.body)).not.toContain('getaddrinfo');
    expect(JSON.stringify(discovered.body)).not.toContain('authorization');
  });
  it('does not project a saved row or a return ticket as Connected', async () => {
    const response = await fetch(`${base}/mcp-servers/oauth-status`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated_server_ids: [] });
  });
  it('rejects explicit managed catalog connect without probing or replacing the old row', async () => {
    const catalog = await app.service('mcp-catalog').find();
    const entries = (Array.isArray(catalog) ? catalog : catalog.data) as Array<{
      name: string;
      auth_type: string;
      permission_disclosure: string;
    }>;
    const entry = entries.find((item) => item.auth_type === 'oauth' && item.permission_disclosure);
    expect(entry).toBeDefined();
    const result = await post('mcp-catalog/connect', {
      catalog_key: entry!.name,
      oauth_client_mode: 'cloud_managed_v1',
      acknowledged_disclosure: entry!.permission_disclosure,
      acknowledged_managed_disclosure: 'invented capability is not authority',
    });
    expect(result.status).toBe(400);
    expect(result.body.message).toMatch(/Managed OAuth is unavailable/);
    expect(await new MCPServerRepository(db).findById(managedRow.mcp_server_id)).toEqual(
      managedRow
    );
  });
});
