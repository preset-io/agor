import type { BranchID, MCPServerID, SessionID, UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, update } from '../database-wrapper';
import { sessionMcpServers, userMcpOauthTokens } from '../schema';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { MCPMarketplaceRepository } from './mcp-marketplace';
import { MCPServerRepository } from './mcp-servers';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';
import { UsersRepository } from './users';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-00000000b0b0' as UserID;

async function sessionFor(db: Database, createdBy: UserID) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `marketplace-${createdBy.slice(-4)}-${Math.random()}`,
    name: 'Marketplace Test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo.git',
    local_path: `/tmp/marketplace-${createdBy.slice(-4)}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/marketplace-${createdBy.slice(-4)}`,
    base_ref: 'main',
    new_branch: false,
    created_by: createdBy as unknown as UUID,
  });
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
    title: `${createdBy === ALICE ? 'Alice' : 'Bob'} session`,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  });
}

describe('MCPMarketplaceRepository', () => {
  dbTest(
    'projects only the current owner, visible sessions, and explicit secret-free fields',
    async ({ db }) => {
      const users = new UsersRepository(db);
      await users.create({
        user_id: ALICE,
        email: 'alice-marketplace@example.invalid',
        role: 'member',
      });
      await users.create({
        user_id: BOB,
        email: 'bob-marketplace@example.invalid',
        role: 'member',
      });
      const servers = new MCPServerRepository(db);
      const aliceServerBase = await servers.create({
        name: 'alice-private',
        display_name: 'Alice private',
        transport: 'http',
        url: 'https://alice-secret-endpoint.invalid/mcp',
        headers: { Authorization: 'alice-header-secret' },
        auth: { type: 'bearer', token: 'alice-token-secret' },
        env: { SECRET_ENV: 'alice-env-secret' },
        scope: 'session',
        source: 'user',
        owner_user_id: ALICE,
      });
      const aliceServer = await servers.update(aliceServerBase.mcp_server_id, {
        tools: [{ name: 'write_task', description: 'Writes a task', input_schema: {} }],
        tool_permissions: { write_task: 'ask' },
      });
      const bobServer = await servers.create({
        name: 'bob-private',
        transport: 'http',
        url: 'https://bob.invalid/mcp',
        auth: { type: 'bearer', token: 'bob-token-secret' },
        scope: 'session',
        source: 'user',
        owner_user_id: BOB,
      });
      await servers.create({
        name: 'shared',
        transport: 'http',
        url: 'https://shared.invalid/mcp',
        auth: { type: 'bearer', token: 'shared-token-secret' },
        scope: 'session',
        source: 'user',
      });

      const aliceSession = await sessionFor(db, ALICE);
      const bobSession = await sessionFor(db, BOB);
      await insert(db, sessionMcpServers)
        .values([
          {
            session_id: aliceSession.session_id,
            mcp_server_id: aliceServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
          // Deliberately stale/invalid cross-owner link: the overview must not
          // disclose Bob's session metadata even to an admin-shaped Alice caller.
          {
            session_id: bobSession.session_id,
            mcp_server_id: aliceServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
          {
            session_id: bobSession.session_id,
            mcp_server_id: bobServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
        ])
        .run();

      const result = await new MCPMarketplaceRepository(db).overviewForUser(ALICE);
      expect(result.servers.map((server) => server.name)).toEqual(['alice-private']);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].session_id).toBe(aliceSession.session_id);
      expect(result.servers[0].session_count).toBe(1);
      expect(result.servers[0].transport).toBe('http');
      expect(result.credentials).toMatchObject([
        {
          mcp_server_id: aliceServer.mcp_server_id as MCPServerID,
          method: 'bearer',
          status: 'configured',
        },
      ]);
      expect(result.servers[0].tools).toMatchObject([{ name: 'write_task', permission: 'ask' }]);

      const forbiddenKeys =
        /^(auth|token|secret|headers?|env|url|endpoint|client_id|resource|issuer)$/i;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          expect(key).not.toMatch(forbiddenKeys);
          visit(child);
        }
      };
      visit(result);
      expect(JSON.stringify(result)).not.toMatch(
        /alice-token-secret|alice-header-secret|alice-env-secret|secret-endpoint|bob-token-secret|shared-token-secret/
      );
    }
  );

  dbTest(
    'derives OAuth usability from refresh authority without exposing tokens',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: 'marketplace-oauth@example.test',
        name: 'Marketplace OAuth',
      });
      const server = await new MCPServerRepository(db).create({
        name: 'oauth-private',
        transport: 'http',
        url: 'https://oauth.invalid/mcp',
        auth: { type: 'oauth', oauth_mode: 'per_user' },
        scope: 'session',
        source: 'catalog',
        catalog_entry_name: 'com.example/oauth',
        owner_user_id: user.user_id,
      });
      const tokens = new UserMCPOAuthTokenRepository(db);
      await tokens.saveToken(user.user_id, server.mcp_server_id, {
        accessToken: 'expired-access-secret',
        refreshToken: 'usable-refresh-secret',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const read = (authorized = true) =>
        new MCPMarketplaceRepository(
          db,
          async (_userId, serverIds) =>
            new Map(serverIds.map((serverId) => [serverId, authorized] as const))
        ).overviewForUser(user.user_id, Date.parse('2026-01-02T00:00:00.000Z'));

      await expect(read()).resolves.toMatchObject({
        credentials: [{ method: 'oauth', status: 'refreshable' }],
      });

      await update(db, userMcpOauthTokens)
        .set({ refresh_status: 'refreshing' })
        .where(eq(userMcpOauthTokens.mcp_server_id, server.mcp_server_id))
        .run();
      await expect(read()).resolves.toMatchObject({
        credentials: [{ status: 'refreshing' }],
      });

      await update(db, userMcpOauthTokens)
        .set({ refresh_status: 'ambiguous' })
        .where(eq(userMcpOauthTokens.mcp_server_id, server.mcp_server_id))
        .run();
      const ambiguous = await read();
      expect(ambiguous.credentials).toMatchObject([{ status: 'reauthentication_required' }]);
      expect(JSON.stringify(ambiguous)).not.toMatch(/expired-access-secret|usable-refresh-secret/);

      await update(db, userMcpOauthTokens)
        .set({ refresh_status: 'idle' })
        .where(eq(userMcpOauthTokens.mcp_server_id, server.mcp_server_id))
        .run();
      await expect(read(false)).resolves.toMatchObject({
        credentials: [{ status: 'reauthentication_required' }],
      });

      await update(db, userMcpOauthTokens)
        .set({ oauth_token_expires_at: new Date('2026-02-01T00:00:00.000Z') })
        .where(eq(userMcpOauthTokens.mcp_server_id, server.mcp_server_id))
        .run();
      await expect(read()).resolves.toMatchObject({
        credentials: [{ status: 'active' }],
      });

      await update(db, userMcpOauthTokens)
        .set({ refresh_status: 'invalid-database-state' as never })
        .where(eq(userMcpOauthTokens.mcp_server_id, server.mcp_server_id))
        .run();
      await expect(read()).resolves.toMatchObject({
        credentials: [{ status: 'reauthentication_required' }],
      });
    }
  );

  dbTest(
    'projects shared grants, excludes another user per-user grant, and keeps authority when disabled',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const alice = await users.create({ email: 'shared-alice@example.test', name: 'Alice' });
      const bob = await users.create({ email: 'shared-bob@example.test', name: 'Bob' });
      const servers = new MCPServerRepository(db);
      const shared = await servers.create({
        name: 'shared-oauth',
        transport: 'http',
        url: 'https://shared-oauth.invalid/mcp',
        auth: { type: 'oauth', oauth_mode: 'shared' },
        scope: 'session',
        source: 'catalog',
        catalog_entry_name: 'com.example/shared-oauth',
        owner_user_id: alice.user_id,
      });
      const otherUsersGrant = await servers.create({
        name: 'per-user-oauth',
        transport: 'http',
        url: 'https://per-user-oauth.invalid/mcp',
        auth: { type: 'oauth', oauth_mode: 'per_user' },
        scope: 'session',
        source: 'catalog',
        catalog_entry_name: 'com.example/per-user-oauth',
        owner_user_id: alice.user_id,
      });
      const tokens = new UserMCPOAuthTokenRepository(db);
      await tokens.saveToken(null, shared.mcp_server_id, {
        accessToken: 'tenant-shared-secret',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      });
      await tokens.saveToken(bob.user_id, otherUsersGrant.mcp_server_id, {
        accessToken: 'bob-private-secret',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      });
      const authorityBatches: MCPServerID[][] = [];
      const repository = new MCPMarketplaceRepository(db, async (_userId, serverIds) => {
        authorityBatches.push([...serverIds]);
        return new Map(serverIds.map((id) => [id, true] as const));
      });

      const initial = await repository.overviewForUser(
        alice.user_id,
        Date.parse('2029-01-01T00:00:00.000Z')
      );
      expect(initial.credentials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mcp_server_id: shared.mcp_server_id,
            status: 'active',
          }),
          expect.objectContaining({
            mcp_server_id: otherUsersGrant.mcp_server_id,
            status: 'not_connected',
          }),
        ])
      );
      expect(authorityBatches).toHaveLength(1);
      expect(authorityBatches[0]).toEqual(
        expect.arrayContaining([shared.mcp_server_id, otherUsersGrant.mcp_server_id])
      );

      await servers.update(shared.mcp_server_id, { enabled: false });
      const disabled = await repository.overviewForUser(
        alice.user_id,
        Date.parse('2029-01-01T00:00:00.000Z')
      );
      expect(disabled.credentials).toContainEqual(
        expect.objectContaining({ mcp_server_id: shared.mcp_server_id, status: 'active' })
      );
      expect(disabled.servers).toContainEqual(
        expect.objectContaining({ mcp_server_id: shared.mcp_server_id, enabled: false })
      );
      expect(JSON.stringify(disabled)).not.toMatch(/tenant-shared-secret|bob-private-secret/);
    }
  );

  dbTest(
    'batch-reads caller and shared grant authority without hydrating access or refresh tokens',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const alice = await users.create({ email: 'authority-alice@example.test', name: 'Alice' });
      const bob = await users.create({ email: 'authority-bob@example.test', name: 'Bob' });
      const servers = new MCPServerRepository(db);
      const createServer = (name: string, mode: 'per_user' | 'shared') =>
        servers.create({
          name,
          transport: 'http',
          url: `https://${name}.invalid/mcp`,
          auth: { type: 'oauth', oauth_mode: mode },
          scope: 'session',
          source: 'user',
          owner_user_id: alice.user_id,
        });
      const [aliceServer, sharedServer, bobServer] = await Promise.all([
        createServer('alice-authority', 'per_user'),
        createServer('shared-authority', 'shared'),
        createServer('bob-authority', 'per_user'),
      ]);
      const tokens = new UserMCPOAuthTokenRepository(db);
      await tokens.saveToken(alice.user_id, aliceServer.mcp_server_id, {
        accessToken: 'alice-access-must-not-hydrate',
        refreshToken: 'alice-refresh-must-not-hydrate',
        clientId: 'alice-client-id',
      });
      await tokens.saveToken(null, sharedServer.mcp_server_id, {
        accessToken: 'shared-access-must-not-hydrate',
        refreshToken: 'shared-refresh-must-not-hydrate',
      });
      await tokens.saveToken(bob.user_id, bobServer.mcp_server_id, {
        accessToken: 'bob-access-must-not-cross-subject',
      });

      const authority = await tokens.listAuthorityForUserAndSharedByServerIds(alice.user_id, [
        aliceServer.mcp_server_id,
        sharedServer.mcp_server_id,
        bobServer.mcp_server_id,
      ]);

      expect(authority.map((grant) => grant.mcp_server_id)).toEqual(
        expect.arrayContaining([aliceServer.mcp_server_id, sharedServer.mcp_server_id])
      );
      expect(authority.map((grant) => grant.mcp_server_id)).not.toContain(bobServer.mcp_server_id);
      for (const grant of authority) {
        expect(grant).not.toHaveProperty('oauth_access_token');
        expect(grant).not.toHaveProperty('oauth_refresh_token');
      }
      expect(JSON.stringify(authority)).not.toMatch(
        /alice-access-must-not-hydrate|alice-refresh-must-not-hydrate|shared-access-must-not-hydrate|shared-refresh-must-not-hydrate|bob-access-must-not-cross-subject/
      );
    }
  );
});
