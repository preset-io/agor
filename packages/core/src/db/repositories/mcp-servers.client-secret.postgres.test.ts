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
import { isBoundSecretEnvelope } from '../oauth-secret-envelope';
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

    it('keeps a non-BYO server secret plaintext on every save, as older daemons read it', async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-client-secret-test-master');
      await runWithTenantDatabaseScope(db, `secret-direct-${generateId()}`, async (scoped) => {
        const owner = await ensureTestUser(scoped, generateId() as UserID);
        const repo = new MCPServerRepository(scoped);
        const created = await repo.create(server(owner, 'manual-plaintext'));
        await repo.update(created.mcp_server_id, { auth: { oauth_scope: 'read' } });
        // The pre-PR reader returned data.auth as stored.
        expect(await storedSecret(scoped, created.mcp_server_id)).toBe('manual-plaintext');
        expect((await repo.findById(created.mcp_server_id))?.auth?.oauth_client_secret).toBe(
          'manual-plaintext'
        );
      });
    });

    it('seals a customer-owned app install, including an old plaintext row on its next save', async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-client-secret-test-master');
      await runWithTenantDatabaseScope(db, `secret-byo-${generateId()}`, async (scoped) => {
        const owner = await ensureTestUser(scoped, generateId() as UserID);
        const repo = new MCPServerRepository(scoped);
        const asana = (secret?: string, installer = owner) => ({
          ...server(installer, secret),
          url: 'https://mcp.asana.com/v2/mcp',
          scope: 'session' as const,
          source: 'catalog' as const,
          catalog_entry_name: 'com.asana/mcp',
        });
        const created = await repo.create(asana('byo-secret'));
        expect(isBoundSecretEnvelope(await storedSecret(scoped, created.mcp_server_id))).toBe(true);
        expect((await repo.findById(created.mcp_server_id))?.auth?.oauth_client_secret).toBe(
          'byo-secret'
        );

        // One catalog install per owner, so the legacy row has its own owner.
        const legacy = await repo.create(
          asana(undefined, await ensureTestUser(scoped, generateId() as UserID))
        );
        const row = await select(scoped, { data: mcpServers.data })
          .from(mcpServers)
          .where(eq(mcpServers.mcp_server_id, legacy.mcp_server_id))
          .one();
        await update(scoped, mcpServers)
          .set({
            data: {
              ...row!.data,
              auth: { ...row!.data.auth!, oauth_client_secret: 'legacy-plaintext' },
            },
          })
          .where(eq(mcpServers.mcp_server_id, legacy.mcp_server_id))
          .run();
        expect((await repo.findById(legacy.mcp_server_id))?.auth?.oauth_client_secret).toBe(
          'legacy-plaintext'
        );
        const saved = await repo.update(legacy.mcp_server_id, { auth: { oauth_scope: 'read' } });
        expect(saved.auth?.oauth_client_secret).toBe('legacy-plaintext');
        expect(isBoundSecretEnvelope(await storedSecret(scoped, legacy.mcp_server_id))).toBe(true);
      });
    });
  }
);
