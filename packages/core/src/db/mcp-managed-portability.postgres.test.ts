/** Real non-owner restore proof; synthetic definitions and disposable owned cluster only. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPServerRepository } from './repositories/mcp-servers';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { UsersRepository } from './repositories/users';
import { readManifest, tableJsonlPath } from './tenant-archive';
import { deleteTenantData } from './tenant-deletion';
import { exportTenant } from './tenant-export';
import { importTenant } from './tenant-import';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

const profile = {
  profile_id: 'synthetic',
  semantic_version: '1',
  environment: 'staging' as const,
  region: 'us-west-2' as const,
  registry_digest: 'a'.repeat(64),
};
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed definition portability on nonowner PostgreSQL',
  () => {
    let owned: OwnedPostgres;
    let scratch: string;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
      scratch = await mkdtemp(join(tmpdir(), 'managed-portability-'));
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }, 30000);
    it.each(['same-tenant restore', 'cross-tenant rehome'])(
      '%s disables managed only and preserves repeated-import hashes',
      async (kind) => {
        const source = `portable-${randomUUID()}`;
        const destination = kind === 'same-tenant restore' ? source : `destination-${randomUUID()}`;
        const definitions = await runWithTenantDatabaseScope(owned.db, source, async (db) => {
          const user = await new UsersRepository(db).create({
            email: `${randomUUID()}@example.invalid`,
            role: 'member',
          });
          const repo = new MCPServerRepository(db);
          const base = {
            name: 'Synthetic portable',
            transport: 'http' as const,
            url: 'https://provider.example.invalid/mcp',
            scope: 'global' as const,
            enabled: true,
            source: 'catalog' as const,
            catalog_entry_name: 'org.example/synthetic',
            owner_user_id: user.user_id,
          };
          const managed = await repo.create({
            ...base,
            auth: {
              type: 'oauth',
              oauth_mode: 'per_user',
              oauth_client_mode: 'cloud_managed_v1',
              oauth_managed_profile: profile,
            },
          });
          const direct = await repo.create({
            ...base,
            name: 'Direct unchanged',
            auth: { type: 'oauth', oauth_mode: 'per_user' },
          });
          return { managed, direct, user };
        });
        const archivePath = join(scratch, source);
        await exportTenant(owned.db, source, { archivePath });
        await deleteTenantData(owned.db, source);
        const imported = await importTenant(owned.db, { archivePath, tenantId: destination });
        expect(imported.alreadyApplied).toBe(false);
        await runWithTenantDatabaseScope(owned.db, destination, async (db) => {
          const repo = new MCPServerRepository(db);
          const managed = await repo.findById(definitions.managed.mcp_server_id);
          const direct = await repo.findById(definitions.direct.mcp_server_id);
          expect(managed).toMatchObject({ enabled: false, source: 'imported', config_version: 1 });
          expect(managed?.catalog_entry_name).toBeUndefined();
          expect(managed?.auth).toMatchObject({
            oauth_client_mode: 'cloud_managed_v1',
            oauth_managed_profile: profile,
          });
          expect(direct?.enabled).toBe(true);
          expect(direct?.source).toBe('imported');
          expect(
            await new UserMCPOAuthTokenRepository(db, 'different-destination-key').getToken(
              definitions.user.user_id,
              definitions.managed.mcp_server_id
            )
          ).toBeNull();
        });
        expect(
          (await importTenant(owned.db, { archivePath, tenantId: destination })).alreadyApplied
        ).toBe(true);
        await deleteTenantData(owned.db, destination);
      },
      30000
    );
    it('never exports managed authority or bearer material', async () => {
      const fixture = await seedManagedRefreshGrant(owned.db, 'synthetic-source-key');
      const archivePath = join(scratch, fixture.tenant);
      await exportTenant(owned.db, fixture.tenant, { archivePath });
      const manifest = await readManifest(archivePath);
      for (const name of [
        'user_mcp_oauth_tokens',
        'mcp_oauth_pending_flows',
        'mcp_managed_oauth_outbox',
        'mcp_managed_oauth_invalidations',
      ]) {
        expect(manifest.database.identity.nonPortableTenantTables).toContain(name);
        expect(manifest.database.tables.some((table) => table.name === name)).toBe(false);
      }
      const definitions = await readFile(tableJsonlPath(archivePath, 'mcp_servers'), 'utf8');
      expect(definitions).not.toContain(fixture.commit.tokens.access_token);
      expect(definitions).not.toContain(fixture.commit.tokens.refresh_token);
      await expect(deleteTenantData(owned.db, fixture.tenant)).rejects.toThrow();
    }, 30000);
  }
);
