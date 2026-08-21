import { describe, expect } from 'vitest';
import type { UserID } from '../../types';
import { dbTest } from '../test-helpers';
import { MCPCatalogCandidateRepository } from './mcp-catalog-candidates';
import { MCPServerRepository } from './mcp-servers';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';
import { UsersRepository } from './users';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-000000000b0b' as UserID;

describe('Marketplace MCP atomic repository actions', () => {
  dbTest(
    'merges concurrent tool toggles without losing Ask or undiscovered rules',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const server = await repo.create({
        name: 'atomic-tools',
        transport: 'http',
        url: 'https://example.test/mcp',
        scope: 'session',
        source: 'user',
        owner_user_id: ALICE,
      });
      await repo.update(server.mcp_server_id, {
        tools: [
          { name: 'a', description: '' },
          { name: 'b', description: '' },
        ],
        tool_permissions: { hidden_rule: 'ask' },
      });

      await Promise.all([
        repo.setOwnedToolEnabled(server.mcp_server_id, ALICE, 'a', false),
        repo.setOwnedToolEnabled(server.mcp_server_id, ALICE, 'b', false),
      ]);
      await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
        tool_permissions: { a: 'deny', b: 'deny', hidden_rule: 'ask' },
      });

      await Promise.all([
        repo.setOwnedToolEnabled(server.mcp_server_id, ALICE, 'a', true),
        repo.update(server.mcp_server_id, {
          tools: [
            { name: 'a', description: 'rediscovered' },
            { name: 'b', description: '' },
            { name: 'c', description: 'new' },
          ],
        }),
      ]);
      await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
        tool_permissions: { b: 'deny', hidden_rule: 'ask' },
        tools: expect.arrayContaining([expect.objectContaining({ name: 'c' })]),
      });
    }
  );

  dbTest('refuses a one-tool mutation for another owner', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const server = await repo.create({
      name: 'owned-tools',
      transport: 'http',
      url: 'https://example.test/mcp',
      scope: 'session',
      source: 'user',
      owner_user_id: ALICE,
    });
    await expect(repo.setOwnedToolEnabled(server.mcp_server_id, BOB, 'a', false)).resolves.toBe(
      false
    );
    await expect(repo.isOwnedBy(server.mcp_server_id, BOB)).resolves.toBe(false);
    await expect(repo.isOwnedBy(server.mcp_server_id, ALICE)).resolves.toBe(true);
  });

  dbTest(
    'catalog candidates recursively omit loaded token, client-secret, and header values',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: 'candidate-owner@example.test',
        name: 'Candidate owner',
      });
      const repo = new MCPServerRepository(db);
      const server = await repo.create({
        name: 'secret-candidate',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { 'x-private': 'raw-header-secret' },
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_client_secret: 'raw-configured-client-secret',
        },
        scope: 'session',
        source: 'user',
        owner_user_id: user.user_id,
      });
      await new UserMCPOAuthTokenRepository(db).saveToken(user.user_id, server.mcp_server_id, {
        accessToken: 'raw-access-token',
        refreshToken: 'raw-refresh-token',
        clientId: 'client-id-is-internal-policy',
        clientSecret: 'raw-grant-client-secret',
        resourceUri: 'https://example.test/mcp',
      });

      const [candidate] = await new MCPCatalogCandidateRepository(db).listForUser(user.user_id);
      expect(candidate.grant).toMatchObject({
        has_access_token: true,
        binding_ready: true,
      });
      expect(Object.keys(candidate.grant ?? {})).not.toEqual(
        expect.arrayContaining([
          'oauth_access_token',
          'oauth_refresh_token',
          'oauth_client_id',
          'oauth_client_secret',
          'grant_binding_fingerprint',
        ])
      );
      expect(candidate.server.headers).toEqual({ __configured__: '••••••••' });
      const serialized = JSON.stringify(candidate);
      for (const secret of [
        'raw-header-secret',
        'raw-configured-client-secret',
        'raw-access-token',
        'raw-refresh-token',
        'raw-grant-client-secret',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
  );
});
