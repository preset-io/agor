/**
 * PostgreSQL row-lock/CAS proof for discovery persistence.
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */
import {
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { Conflict } from '@agor/core/feathers';
import type { MCPServer, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureMCPDiscoveryAuthority,
  persistDiscoveredMCPCapabilities,
} from './mcp-discovered-capabilities.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'discovery authority/configuration CAS (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('rejects a held endpoint result, then accepts a fresh control result', async () => {
      const tenantId = `mcp-discovery-${generateId()}`;
      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Postgres discovery owner',
          role: 'member',
        });
        const server = await new MCPServerRepository(scoped).create({
          name: 'postgres-discovery',
          transport: 'http',
          url: 'https://a.example.test/mcp',
          scope: 'session',
          source: 'user',
          owner_user_id: owner.user_id as UserID,
        });
        return { ownerId: owner.user_id as UserID, server };
      });

      const stale = await captureMCPDiscoveryAuthority(
        db,
        tenantId,
        seeded.ownerId,
        seeded.server as MCPServer
      );
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await new MCPServerRepository(scoped).update(seeded.server.mcp_server_id, {
          url: 'https://b.example.test/mcp',
        });
      });
      const capabilities = { tools: [{ name: 'search' }], resources: [], prompts: [] };
      await expect(
        persistDiscoveredMCPCapabilities(db, tenantId, stale, capabilities)
      ).rejects.toBeInstanceOf(Conflict);

      const current = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new MCPServerRepository(scoped).findById(seeded.server.mcp_server_id)
      );
      const fresh = await captureMCPDiscoveryAuthority(db, tenantId, seeded.ownerId, current!);
      await persistDiscoveredMCPCapabilities(db, tenantId, fresh, capabilities);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await expect(
          new MCPServerRepository(scoped).findById(seeded.server.mcp_server_id)
        ).resolves.toMatchObject({ url: 'https://b.example.test/mcp', tools: capabilities.tools });
      });
    });
  }
);
