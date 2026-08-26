/**
 * PostgreSQL overlap proof for catalog-connect compensation.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, SessionID, UserID, UUID } from '../../types';
import { SessionStatus } from '../../types';
import { createDatabase, type Database } from '../client';
import { insert, isPostgresDatabase, runDatabaseTransaction } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { sessionMcpServers } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { MCPServerRepository } from './mcp-servers';
import { RepoRepository } from './repos';
import { SessionMCPServerRepository } from './session-mcp-servers';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP server cleanup serialization (PostgreSQL)',
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

    it('preserves an install adopted by an uncommitted overlapping transaction', async () => {
      const tenantId = `mcp-cleanup-${generateId()}`;
      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.com`,
          name: 'Cleanup race owner',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `mcp-cleanup-${generateId()}`,
          name: 'MCP cleanup race',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/mcp-cleanup.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: 'main',
          ref: 'main',
          branch_unique_id: Date.now() % 1_000_000,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id as UUID,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          created_by: user.user_id as UserID,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: 'catalog-race',
          transport: 'http',
          url: 'https://catalog.example/mcp',
          scope: 'session',
          source: 'catalog',
          catalog_entry_name: 'com.example/cleanup-race',
          owner_user_id: user.user_id as UserID,
        });
        return { sessionId: session.session_id, serverId: server.mcp_server_id };
      });

      let attachmentInserted!: () => void;
      const inserted = new Promise<void>((resolve) => (attachmentInserted = resolve));
      let commitAdoption!: () => void;
      const mayCommit = new Promise<void>((resolve) => (commitAdoption = resolve));

      const adoption = runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        runDatabaseTransaction(scoped, async (tx) => {
          await insert(tx, sessionMcpServers)
            .values({
              session_id: seeded.sessionId,
              mcp_server_id: seeded.serverId,
              enabled: true,
              added_at: new Date(),
            })
            .run();
          attachmentInserted();
          await mayCommit;
        })
      );
      await inserted;

      let cleanupSettled = false;
      const cleanup = runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new MCPServerRepository(scoped).deleteIfUnattached(seeded.serverId)
      ).finally(() => {
        cleanupSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cleanupSettled).toBe(false);

      commitAdoption();
      await adoption;
      await expect(cleanup).resolves.toBe(false);

      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        await expect(
          new MCPServerRepository(scoped).findById(seeded.serverId)
        ).resolves.toMatchObject({ mcp_server_id: seeded.serverId });
        await expect(
          new SessionMCPServerRepository(scoped).getRelationship(seeded.sessionId, seeded.serverId)
        ).resolves.not.toBeNull();
      });
    });

    it('atomically merges independent tool decisions on PostgreSQL', async () => {
      const tenantId = `mcp-tools-${generateId()}`;
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.com`,
          name: 'Tool owner',
        });
        const repo = new MCPServerRepository(scoped);
        const server = await repo.create({
          name: 'postgres-tools',
          transport: 'http',
          url: 'https://example.test/mcp',
          scope: 'session',
          source: 'user',
          owner_user_id: user.user_id as UserID,
        });
        await repo.update(server.mcp_server_id, {
          tool_permissions: { hidden_rule: 'ask' },
        });
        await Promise.all([
          repo.setOwnedToolEnabled(server.mcp_server_id, user.user_id as UserID, 'a', false),
          repo.setOwnedToolEnabled(server.mcp_server_id, user.user_id as UserID, 'b', false),
        ]);
        await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
          tool_permissions: { a: 'deny', b: 'deny', hidden_rule: 'ask' },
        });
      });
    });
  }
);
