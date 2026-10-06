/**
 * PostgreSQL custody of configured OAuth app secrets.
 *
 * Run with AGOR_DB_DIALECT=postgresql and AGOR_TEST_POSTGRES_URL set.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { select, update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { mcpServers } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { ensureTestUser } from '../test-helpers';
import { MCPServerRepository } from './mcp-servers';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'configured OAuth client secret custody (PostgreSQL)',
  () => {
    let db: Database;
    const server = (owner: UserID, secret?: string) => ({
      name: `app-${generateId()}`,
      transport: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      scope: 'global' as const,
      enabled: true,
      source: 'user' as const,
      owner_user_id: owner,
      auth: {
        type: 'oauth' as const,
        oauth_client_id: 'customer-app',
        ...(secret ? { oauth_client_secret: secret } : {}),
      },
    });
    const storedSecret = async (scoped: Database, id: string) =>
      (
        await select(scoped, { data: mcpServers.data })
          .from(mcpServers)
          .where(eq(mcpServers.mcp_server_id, id))
          .one()
      )?.data.auth?.oauth_client_secret;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    }, 60000);
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('stores an env-reference secret as-is without the deployment key', async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', '');
      await runWithTenantDatabaseScope(db, `secret-ref-${generateId()}`, async (scoped) => {
        const owner = await ensureTestUser(scoped, generateId() as UserID);
        const repo = new MCPServerRepository(scoped);
        const created = await repo.create(server(owner, '{{ user.env.CLIENT_SECRET }}'));
        expect(await storedSecret(scoped, created.mcp_server_id)).toBe(
          '{{ user.env.CLIENT_SECRET }}'
        );
        expect((await repo.findById(created.mcp_server_id))?.auth?.oauth_client_secret).toBe(
          '{{ user.env.CLIENT_SECRET }}'
        );
      });
    });

    it('reads an old plaintext row and seals it on the next save', async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-client-secret-test-master');
      await runWithTenantDatabaseScope(db, `secret-legacy-${generateId()}`, async (scoped) => {
        const owner = await ensureTestUser(scoped, generateId() as UserID);
        const repo = new MCPServerRepository(scoped);
        const created = await repo.create(server(owner));
        const row = await select(scoped, { data: mcpServers.data })
          .from(mcpServers)
          .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
          .one();
        await update(scoped, mcpServers)
          .set({
            data: {
              ...row!.data,
              auth: { ...row!.data.auth!, oauth_client_secret: 'legacy-plaintext' },
            },
          })
          .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
          .run();

        const legacy = await repo.findById(created.mcp_server_id);
        expect(legacy?.auth?.oauth_client_secret).toBe('legacy-plaintext');
        const saved = await repo.update(created.mcp_server_id, {
          auth: { oauth_scope: 'read' },
        });
        expect(saved.auth?.oauth_client_secret).toBe('legacy-plaintext');
        expect(await storedSecret(scoped, created.mcp_server_id)).not.toContain('legacy-plaintext');
      });
    });
  }
);
