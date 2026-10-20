/** PostgreSQL authority/mutation serialization proof for Marketplace actions. */
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  insert,
  isPostgresDatabase,
  MCPMarketplaceRepository,
  MCPServerRepository,
  RepoRepository,
  runDatabaseTransaction,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  sessionMcpServers,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  MCPServerID,
  SessionID,
  TenantID,
  UserID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MCPMarketplaceRemoveServerService,
  MCPMarketplaceToolPermissionService,
} from './mcp-marketplace-actions';
import { resolveMCPMarketplaceOAuthGrantAuthority } from './mcp-oauth-grant-authority';
import { SessionMCPServersService } from './session-mcp-servers';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Marketplace action authority transaction (PostgreSQL)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'mcp-actions-test',
      });
    });

    afterAll(async () => {
      await (rawDb as typeof rawDb & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function seed() {
      const tenantId = `marketplace-action-${generateId()}` as TenantID;
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          role: 'member',
        });
        await setMcpMemberPolicy(scoped, 'allow_private_only', tenantId);
        const server = await new MCPServerRepository(scoped).create({
          name: 'postgres-marketplace-action',
          transport: 'http',
          url: 'https://example.test/mcp',
          scope: 'session',
          source: 'user',
          owner_user_id: user.user_id as UserID,
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `delete-${generateId()}`,
          name: 'Delete fixture',
          repo_type: 'remote',
          remote_url: 'https://example.test/repo.git',
          local_path: '/tmp/mcp-delete',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: 'fixture',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1000000),
          path: '/tmp/mcp-delete',
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          created_by: user.user_id,
          status: SessionStatus.IDLE,
          agentic_tool: 'claude-code',
        });
        return {
          tenantId,
          userId: user.user_id as UserID,
          serverId: server.mcp_server_id,
          session,
        };
      });
    }

    const params = (tenantId: TenantID, userId: UserID): AuthenticatedParams =>
      ({
        provider: 'rest',
        tenant: { tenant_id: tenantId },
        // Intentionally stale: the transaction must reload the users row.
        user: { user_id: userId, role: 'member' },
      }) as AuthenticatedParams;

    it('refuses cross-tenant discovery and confirmed deletion with no side effects', async () => {
      const a = await seed();
      const b = await seed();
      const action = new MCPMarketplaceRemoveServerService(db);
      await expect(
        action.create(
          { mcp_server_id: a.serverId, detach: true, expected_session_count: 0 },
          params(b.tenantId, b.userId)
        )
      ).rejects.toBeInstanceOf(NotFound);
      await runWithTenantDatabaseScope(db, b.tenantId, async (scoped) => {
        expect(
          (await new SessionMCPServersService(db).listAvailableServers(b.session, b.userId)).map(
            (s) => s.mcp_server_id
          )
        ).not.toContain(a.serverId);
        expect(
          (await new MCPMarketplaceRepository(scoped).overviewForUser(a.userId)).servers
        ).toEqual([]);
      });
      await runWithTenantDatabaseScope(db, a.tenantId, async (scoped) => {
        expect(await new MCPServerRepository(scoped).findById(a.serverId)).not.toBeNull();
      });
    });

    it('lists only its own tenant Shared servers to an admin', async () => {
      const seedShared = async () => {
        const fixture = await seed();
        return runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
          const admin = await new UsersRepository(scoped).create({
            email: `${generateId()}@example.test`,
            role: 'admin',
          });
          const shared = await new MCPServerRepository(scoped).create({
            name: `shared-${fixture.tenantId}`,
            transport: 'http',
            url: 'https://example.test/shared-mcp',
            auth: { type: 'oauth', oauth_mode: 'shared' },
            scope: 'global',
            source: 'user',
          });
          await new UserMCPOAuthTokenRepository(scoped, 'test-master-secret').saveToken(
            null,
            shared.mcp_server_id,
            {
              accessToken: `token-${fixture.tenantId}`,
              clientId: 'shared-client',
              expiresAt: new Date(Date.now() + 60_000),
              // PostgreSQL grants must carry a configuration binding; listing
              // scope is under test here, not binding verification.
              grantBinding: {
                generation: 1,
                version: 1,
                fingerprint: 'a'.repeat(64),
                metadataUri: 'https://example.test/.well-known/oauth-protected-resource',
                resourceUri: 'https://example.test/shared-mcp',
                issuer: 'https://provider.example.test',
                authorizationEndpoint: 'https://provider.example.test/authorize',
                tokenEndpoint: 'https://provider.example.test/token',
                redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
              },
            },
            admin.user_id as UserID
          );
          await new SessionMCPServerRepository(scoped).addServer(
            fixture.session.session_id,
            shared.mcp_server_id
          );
          return { ...fixture, adminId: admin.user_id as UserID, sharedId: shared.mcp_server_id };
        });
      };
      const a = await seedShared();
      const b = await seedShared();
      const overview = await runWithTenantDatabaseScope(db, a.tenantId, (scoped) =>
        new MCPMarketplaceRepository(scoped, (userId, serverIds, options) =>
          resolveMCPMarketplaceOAuthGrantAuthority({
            db: scoped,
            userId,
            serverIds,
            serverRepository: new MCPServerRepository(scoped),
            tokenRepository: new UserMCPOAuthTokenRepository(scoped, 'test-master-secret'),
            includeShared: options?.includeShared,
          })
        ).overviewForUser(a.adminId, undefined, { includeShared: true })
      );
      expect(overview.servers.map((server) => [server.mcp_server_id, server.shared])).toEqual([
        [a.sharedId, true],
      ]);
      expect(overview.servers[0].session_count).toBe(1);
      expect(overview.credentials.map((credential) => credential.mcp_server_id)).toEqual([
        a.sharedId,
      ]);
      expect(overview.attachments.map((item) => item.mcp_server_id)).not.toContain(b.sharedId);
      expect(JSON.stringify(overview)).not.toContain(b.tenantId);
      expect(JSON.stringify(overview)).not.toContain(b.sharedId);
      expect(JSON.stringify(overview)).not.toContain(b.session.session_id);
    });

    it('an attachment that wins the lock invalidates the confirmed count without detaching', async () => {
      const fixture = await seed();
      let inserted!: () => void;
      const ready = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attachment = runWithTenantDatabaseScope(db, fixture.tenantId, (scoped) =>
        runDatabaseTransaction(scoped, async (tx) => {
          await insert(tx, sessionMcpServers)
            .values({
              session_id: fixture.session.session_id,
              mcp_server_id: fixture.serverId,
              enabled: true,
              added_at: new Date(),
            })
            .run();
          inserted();
          await held;
        })
      );
      await ready;
      const deletion = new MCPMarketplaceRemoveServerService(db).create(
        { mcp_server_id: fixture.serverId, detach: true, expected_session_count: 0 },
        params(fixture.tenantId, fixture.userId)
      );
      const rejected = expect(deletion).rejects.toBeInstanceOf(Conflict);
      release();
      await attachment;
      await rejected;
      await runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
        expect(
          await new MCPServerRepository(scoped).countSessionAttachments(fixture.serverId)
        ).toBe(1);
      });
    });

    it('confirmed deletion cascades and a late attachment cannot survive its parent', async () => {
      const fixture = await seed();
      await runWithTenantDatabaseScope(db, fixture.tenantId, (scoped) =>
        new SessionMCPServerRepository(scoped).addServer(
          fixture.session.session_id,
          fixture.serverId
        )
      );
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const action = new MCPMarketplaceRemoveServerService(db, undefined, async (tx, id) => {
        locked();
        await held;
        await new MCPServerRepository(tx).delete(id);
      });
      const deletion = action.create(
        { mcp_server_id: fixture.serverId, detach: true, expected_session_count: 1 },
        params(fixture.tenantId, fixture.userId)
      );
      await ready;
      const attachment = runWithTenantDatabaseScope(db, fixture.tenantId, (scoped) =>
        new SessionMCPServerRepository(scoped).setServers(fixture.session.session_id, [
          fixture.serverId,
        ])
      );
      const rejected = expect(attachment).rejects.toThrow();
      release();
      await deletion;
      await rejected;
      await runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
        expect(await new MCPServerRepository(scoped).findById(fixture.serverId)).toBeNull();
        expect(
          await new SessionMCPServerRepository(scoped).getRelationship(
            fixture.session.session_id,
            fixture.serverId
          )
        ).toBeNull();
      });
    });

    it('commits authorization and one-tool mutation in one PostgreSQL transaction', async () => {
      const seeded = await seed();
      await expect(
        new MCPMarketplaceToolPermissionService(db as TenantScopeAwareDatabase).create(
          {
            mcp_server_id: seeded.serverId,
            tool_name: 'issues.create',
            enabled: false,
          },
          params(seeded.tenantId, seeded.userId)
        )
      ).resolves.toMatchObject({ permission: 'deny' });
      await runWithTenantDatabaseScope(db, seeded.tenantId, async (scoped) => {
        await expect(
          new MCPServerRepository(scoped).findById(seeded.serverId)
        ).resolves.toMatchObject({ tool_permissions: { 'issues.create': 'deny' } });
      });
    });

    it.each([
      [
        'role demotion',
        async (
          scoped: TenantScopedDatabase,
          userId: UserID,
          _tenantId: TenantID,
          _serverId: MCPServerID
        ) => {
          await new UsersRepository(scoped).update(userId, { role: 'viewer' });
        },
      ],
      [
        'policy tightening',
        async (
          scoped: TenantScopedDatabase,
          _userId: UserID,
          tenantId: TenantID,
          _serverId: MCPServerID
        ) => {
          await setMcpMemberPolicy(scoped, 'use_existing_only', tenantId);
        },
      ],
      [
        'transport replacement',
        async (
          scoped: TenantScopedDatabase,
          _userId: UserID,
          _tenantId: TenantID,
          serverId: MCPServerID
        ) => {
          await new MCPServerRepository(scoped).update(serverId, {
            transport: 'stdio',
            command: 'catalog-authority-replacement',
          });
        },
      ],
    ] as const)('rejects stale request authority after %s', async (_name, change) => {
      const seeded = await seed();
      await runWithTenantDatabaseScope(db, seeded.tenantId, (scoped) =>
        change(scoped, seeded.userId, seeded.tenantId, seeded.serverId)
      );
      await expect(
        new MCPMarketplaceToolPermissionService(db as TenantScopeAwareDatabase).create(
          {
            mcp_server_id: seeded.serverId,
            tool_name: 'issues.create',
            enabled: false,
          },
          params(seeded.tenantId, seeded.userId)
        )
      ).rejects.toBeInstanceOf(Forbidden);
    });
  }
);
