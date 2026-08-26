/** PostgreSQL authority/mutation serialization proof for Marketplace actions. */
import {
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPServerID, TenantID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPMarketplaceToolPermissionService } from './mcp-marketplace-actions';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Marketplace action authority transaction (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as typeof db & { $client: { end: () => Promise<void> } }).$client.end();
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
        return { tenantId, userId: user.user_id as UserID, serverId: server.mcp_server_id };
      });
    }

    const params = (tenantId: TenantID, userId: UserID): AuthenticatedParams =>
      ({
        provider: 'rest',
        tenant: { tenant_id: tenantId },
        // Intentionally stale: the transaction must reload the users row.
        user: { user_id: userId, role: 'member' },
      }) as AuthenticatedParams;

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
