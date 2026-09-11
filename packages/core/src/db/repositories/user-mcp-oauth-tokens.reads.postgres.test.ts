import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { MCPServerID, UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { insert, select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { sealBoundSecret } from '../oauth-secret-envelope';
import { userMcpOauthTokens } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { ensureTestUser } from '../test-helpers';
import { MCPServerRepository } from './mcp-servers';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'asynchronous grant reads preserve PostgreSQL RLS and subject isolation',
  () => {
    let db: Database;
    const master = 'synthetic-grant-read-test-master';
    const tenantA = `grant-a-${generateId()}`;
    const tenantB = `grant-b-${generateId()}`;
    const owners = new Map<string, { user: UserID; server: MCPServerID }>();

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      const role = await select(db, { safe: sql<boolean>`NOT rolsuper AND NOT rolbypassrls` })
        .from(sql`pg_roles`)
        .where(sql`rolname = current_user`)
        .one();
      expect(role?.safe).toBe(true);
      for (const tenant of [tenantA, tenantB]) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          const user = await ensureTestUser(scoped, generateId() as UserID);
          const server = await new MCPServerRepository(scoped).create({
            name: 'synthetic',
            transport: 'http',
            url: 'https://example.test/mcp',
            scope: 'global',
            enabled: true,
            source: 'user',
            owner_user_id: user,
          });
          owners.set(tenant, { user, server: server.mcp_server_id });
          for (const subject of [user, null]) {
            const seal = (
              value: string,
              purpose: 'access-token' | 'refresh-token' | 'client-id' | 'client-secret',
              field: string
            ) =>
              sealBoundSecret(
                value,
                master,
                purpose,
                [tenant, subject ?? '<shared>', server.mcp_server_id, '1', field].join('\0')
              );
            await insert(scoped, userMcpOauthTokens)
              .values({
                tenant_id: tenant,
                user_id: subject,
                granted_by_user_id: user,
                mcp_server_id: server.mcp_server_id,
                oauth_access_token: seal('synthetic-access', 'access-token', 'access'),
                oauth_refresh_token: seal('synthetic-refresh', 'refresh-token', 'refresh'),
                oauth_client_id: seal('synthetic-client', 'client-id', 'client-id'),
                oauth_client_secret: seal('synthetic-secret', 'client-secret', 'client-secret'),
                grant_generation: 1,
                created_at: new Date(),
              })
              .run();
          }
        });
      }
    }, 60000);

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('retains each concurrent tenant context across KDF awaits and rejects foreign IDs', async () => {
      await Promise.all(
        [tenantA, tenantB].map(async (tenant) => {
          await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
            const own = owners.get(tenant)!;
            const foreign = owners.get(tenant === tenantA ? tenantB : tenantA)!;
            const repo = new UserMCPOAuthTokenRepository(scoped, master);
            const [personal, shared] = await Promise.all([
              repo.listForUser(own.user),
              repo.listShared(),
            ]);
            expect(personal).toMatchObject([
              {
                user_id: own.user,
                mcp_server_id: own.server,
                oauth_access_token: 'synthetic-access',
              },
            ]);
            expect(shared).toMatchObject([
              {
                user_id: null,
                mcp_server_id: own.server,
                oauth_refresh_token: 'synthetic-refresh',
              },
            ]);
            const status = await repo.listStatusForSubject(own.user);
            expect(status).toHaveLength(1);
            expect(status[0]).not.toHaveProperty('oauth_access_token');
            expect(status[0]).not.toHaveProperty('oauth_refresh_token');
            await expect(repo.listStatusForSubject(foreign.user)).resolves.toEqual([]);
            const sharedStatus = await repo.listStatusForSubject(null);
            expect(sharedStatus).toHaveLength(1);
            expect(sharedStatus[0].mcp_server_id).toBe(own.server);
            const servers = await new MCPServerRepository(scoped).findByIds([
              own.server,
              foreign.server,
              own.server,
            ]);
            expect(servers.map((server) => server.mcp_server_id)).toEqual([own.server]);
            expect(personal).toHaveLength(1);
            expect(shared).toHaveLength(1);
            await expect(repo.listForUser(foreign.user)).resolves.toEqual([]);
            await expect(repo.getToken(foreign.user, foreign.server)).resolves.toBeNull();
            await expect(repo.getToken(null, foreign.server)).resolves.toBeNull();
            const authority = await repo.listAuthorityForUserAndSharedByServerIds(own.user, [
              own.server,
              foreign.server,
            ]);
            expect(authority).toHaveLength(2);
            expect(
              authority.every(
                (record) =>
                  record.mcp_server_id === own.server &&
                  record.oauth_client_secret === 'synthetic-secret'
              )
            ).toBe(true);
            expect(await repo.getCatalogGrantAuthority(own.user, own.server)).toMatchObject({
              oauth_client_id: 'synthetic-client',
              oauth_client_secret: 'synthetic-secret',
            });
            await expect(
              repo.getCatalogGrantAuthority(foreign.user, foreign.server)
            ).resolves.toBeNull();
            // A valid same-tenant row belonging to a different user is not returned.
            const other = await ensureTestUser(scoped, generateId() as UserID);
            await expect(repo.listForUser(other)).resolves.toEqual([]);
            await expect(repo.getToken(other, own.server)).resolves.toBeNull();
            const otherAuthority = await repo.listAuthorityForUserAndSharedByServerIds(other, [
              own.server,
            ]);
            expect(otherAuthority).toHaveLength(1);
            expect(otherAuthority[0].user_id).toBeNull();
            await expect(repo.getCatalogGrantAuthority(other, own.server)).resolves.toBeNull();
            const rows = await select(scoped)
              .from(userMcpOauthTokens)
              .where(eq(userMcpOauthTokens.mcp_server_id, foreign.server))
              .all();
            expect(rows).toEqual([]);
          });
        })
      );
    });
  }
);
