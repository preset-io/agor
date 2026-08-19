import http from 'node:http';
import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { refreshAndPersistToken } from '@agor/core/tools/mcp/oauth-refresh';
import type { MCPServerID, UserID } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { persistOAuthToken } from './oauth-cache';

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('standalone OAuth token persistence', () => {
  it('refreshes through the discovered authorization-server endpoint on SQLite', async () => {
    let refreshBody = '';
    const authorizationServer = await listen((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        refreshBody += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'refreshed-access', expires_in: 3600 }));
      });
    });
    const tokenEndpoint = `${authorizationServer}/oauth/token`;
    // Deliberately distinct (and unused) resource origin. If persistence drops
    // the discovered token endpoint, refresh will try this origin and fail.
    const resourceUri = 'http://127.0.0.1:9/mcp';
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = rawDb as unknown as TenantScopeAwareDatabase;

    try {
      await runMigrations(rawDb);
      const user = await new UsersRepository(rawDb).create({
        email: 'sqlite-oauth@example.com',
        role: 'member',
      });
      const server = await new MCPServerRepository(rawDb).create({
        name: 'sqlite-distinct-oauth-origin',
        transport: 'http',
        url: resourceUri,
        scope: 'global',
        owner_user_id: user.user_id as UserID,
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_client_id: 'standalone-client',
        },
      });

      await persistOAuthToken(
        db,
        { access_token: 'initial-access', refresh_token: 'refresh-token', expires_in: 60 },
        {
          mcpServerId: server.mcp_server_id,
          userId: user.user_id,
          oauthMode: 'per_user',
          clientId: 'standalone-client',
          tokenEndpoint,
          resourceUri,
        },
        'SQLite OAuth test'
      );

      const stored = await new UserMCPOAuthTokenRepository(rawDb).getToken(
        user.user_id as UserID,
        server.mcp_server_id as MCPServerID
      );
      expect(stored?.oauth_token_endpoint).toBe(tokenEndpoint);
      expect(stored?.oauth_resource_uri).toBe(resourceUri);
      expect(
        (await new MCPServerRepository(rawDb).findById(server.mcp_server_id))?.auth
      ).not.toHaveProperty('oauth_token_url');

      await expect(
        refreshAndPersistToken({
          db,
          userId: user.user_id as UserID,
          mcpServerId: server.mcp_server_id as MCPServerID,
          validateGrant: async () => true,
        })
      ).resolves.toBe('refreshed-access');
      expect(new URLSearchParams(refreshBody).get('resource')).toBe(resourceUri);
      expect(
        (
          await new UserMCPOAuthTokenRepository(rawDb).getToken(
            user.user_id as UserID,
            server.mcp_server_id as MCPServerID
          )
        )?.oauth_token_endpoint
      ).toBe(tokenEndpoint);
    } finally {
      const client = (rawDb as unknown as { $client?: { close(): void } }).$client;
      client?.close();
    }
  });
});
