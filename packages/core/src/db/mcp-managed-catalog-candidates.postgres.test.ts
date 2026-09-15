import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserID } from '../types';
import { executeRaw } from './database-wrapper';
import { MCPCatalogCandidateRepository } from './repositories/mcp-catalog-candidates';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import { createOwnedPostgres, type OwnedPostgres } from './test-support/owned-postgres';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed Catalog candidate authority projection (real non-owner)',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    const profile = {
      profile_id: 'profile',
      semantic_version: '1',
      environment: 'staging',
      region: 'us-west-2',
      registry_digest: 'b'.repeat(64),
    };
    const auth = {
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_client_mode: 'cloud_managed_v1',
      oauth_managed_profile: profile,
    };
    it('preserves the exact nonsecret managed policy and v5 binding without crossing owner scopes', async () => {
      const f = await seedManagedRefreshGrant(owned.db, 'synthetic-candidate-master');
      const read = (tenant: string, user: UserID) =>
        runWithTenantDatabaseScope(owned.db, tenant, (db) =>
          new MCPCatalogCandidateRepository(db).listForUser(user)
        );
      const candidates = await read(f.tenant, f.user);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].server.auth).toEqual(auth);
      expect(candidates[0].grant?.binding_ready).toBe(true);
      expect(JSON.stringify(candidates)).not.toContain('synthetic-access-');
      expect(JSON.stringify(candidates)).not.toContain('synthetic-refresh-');
      expect(candidates[0].grant).not.toHaveProperty('managed_metadata');
      expect(await read(`foreign-${randomUUID()}`, f.user)).toEqual([]);
      expect(await read(f.tenant, randomUUID() as UserID)).toEqual([]);
    });
    it('never projects corrupt managed authority as a historical direct install', async () => {
      const f = await seedManagedRefreshGrant(owned.db, 'synthetic-candidate-master');
      for (const changed of [
        { ...auth, oauth_client_mode: 'future_managed' },
        { ...auth, oauth_client_mode: null },
        { ...auth, oauth_client_mode: 'direct' },
        { type: 'oauth', oauth_managed_profile: profile },
        { ...auth, oauth_managed_profile: null },
        { ...auth, oauth_managed_profile: { ...profile, private_extra: 'SENTINEL_NOT_RETURNED' } },
      ]) {
        await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
          await executeRaw(
            db,
            sql`UPDATE public.mcp_servers SET data=jsonb_set(data,'{auth}',${JSON.stringify(changed)}::jsonb) WHERE mcp_server_id=${f.server}`
          );
          await expect(new MCPCatalogCandidateRepository(db).listForUser(f.user)).rejects.toThrow(
            /MCP OAuth client mode|Managed OAuth|managed OAuth/
          );
        });
      }
    });
    it('keeps absent and explicit direct modes direct, without accepting a managed v5 grant', async () => {
      const f = await seedManagedRefreshGrant(owned.db, 'synthetic-candidate-master');
      for (const changed of [{ type: 'oauth' }, { type: 'oauth', oauth_client_mode: 'direct' }]) {
        await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
          await executeRaw(
            db,
            sql`UPDATE public.mcp_servers SET data=jsonb_set(data,'{auth}',${JSON.stringify(changed)}::jsonb) WHERE mcp_server_id=${f.server}`
          );
          const [candidate] = await new MCPCatalogCandidateRepository(db).listForUser(f.user);
          expect(candidate.server.auth).toEqual(changed);
          expect(candidate.grant?.binding_ready).toBe(false);
        });
      }
    });
  }
);
