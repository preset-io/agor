import { expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { MCPServerRepository } from './mcp-servers';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';

dbTest('round-trips the token-endpoint auth method with an OAuth grant', async ({ db }) => {
  const server = await new MCPServerRepository(db).create({
    name: 'oauth-test-server',
    transport: 'http',
    url: 'https://mcp.example.test/',
    scope: 'global',
    enabled: true,
    source: 'user',
  });

  const repository = new UserMCPOAuthTokenRepository(db);
  await repository.saveToken(null, server.mcp_server_id, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    tokenEndpoint: 'https://auth.example.test/token',
    tokenAuthMethod: 'client_secret_post',
  });

  const stored = await repository.getToken(null, server.mcp_server_id);
  expect(stored).toMatchObject({
    oauth_token_auth_method: 'client_secret_post',
    oauth_client_id: 'client-id',
    oauth_client_secret: 'client-secret',
  });
});
