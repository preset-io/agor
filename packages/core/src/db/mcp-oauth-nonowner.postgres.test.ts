import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MCPOAuthAttemptID } from '../types';
import { executeRaw, rawRows } from './database-wrapper';
import { MCPOAuthPendingFlowRepository } from './repositories/mcp-oauth-pending-flows';
import { MCPServerRepository } from './repositories/mcp-servers';
import { UsersRepository } from './repositories/users';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import {
  assertNonOwnerPostgres,
  createOwnedPostgres,
  type OwnedPostgres,
} from './test-support/owned-postgres';

// This suite owns a whole disposable cluster, not merely a database on a
// supplied URL. The normal PG runner's database-owner role is not this proof.
describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'MCP OAuth with a real non-owner runtime role',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120_000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30_000);

    async function seed() {
      const tenant = `managed-proof-${randomUUID()}`;
      const attemptId = randomUUID() as MCPOAuthAttemptID;
      const stateHash = createHash('sha256').update(randomUUID()).digest('hex');
      return runWithTenantDatabaseScope(owned.db, tenant, async (db) => {
        const user = await new UsersRepository(db).create({
          email: `${randomUUID()}@example.test`,
          role: 'member',
        });
        const server = await new MCPServerRepository(db).create({
          name: 'Synthetic provider',
          transport: 'http',
          url: 'https://provider.example.test/mcp',
          scope: 'global',
          enabled: true,
          source: 'user',
          owner_user_id: user.user_id,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        });
        const repo = new MCPOAuthPendingFlowRepository(db);
        const subject = {
          tenantId: tenant,
          mcpServerId: server.mcp_server_id,
          oauthMode: 'per_user' as const,
          subjectUserId: user.user_id,
        };
        await repo.create({
          ...subject,
          attemptId,
          stateHash,
          userId: user.user_id,
          grantGeneration: await repo.allocateGrantGeneration(subject),
          configFingerprintVersion: 4,
          configFingerprint: 'a'.repeat(64),
          envelopeVersion: 1,
          sealedMaterial: 'synthetic-sealed-fixture',
          ttlMs: 600_000,
        });
        return {
          tenant,
          attemptId,
          stateHash,
          userId: user.user_id,
          serverId: server.mcp_server_id,
        };
      });
    }

    it('cannot own tables, assume the owner, or disable lifecycle triggers', async () => {
      await assertNonOwnerPostgres(owned.sql);
      await expect(owned.sql.unsafe('SET ROLE bootstrap')).rejects.toMatchObject({ code: '42501' });
      await expect(owned.sql.unsafe('ALTER TABLE users DISABLE TRIGGER ALL')).rejects.toMatchObject(
        { code: '42501' }
      );
      const rows = await owned.sql`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'mcp_oauth_pending_flows'::regclass`;
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('denies another tenant read, update, delete and manual claim of the same attempt', async () => {
      const flow = await seed();
      await runWithTenantDatabaseScope(owned.peer, `${flow.tenant}-foreign`, async (db) => {
        for (const statement of [
          sql`SELECT attempt_id FROM mcp_oauth_pending_flows WHERE attempt_id = ${flow.attemptId}`,
          sql`UPDATE mcp_oauth_pending_flows SET is_current = false WHERE attempt_id = ${flow.attemptId} RETURNING attempt_id`,
          sql`DELETE FROM mcp_oauth_pending_flows WHERE attempt_id = ${flow.attemptId} RETURNING attempt_id`,
        ])
          expect(rawRows(await executeRaw(db, statement))).toEqual([]);
        const result = await new MCPOAuthPendingFlowRepository(db).claimForUser(
          flow.tenant,
          flow.userId,
          flow.stateHash,
          randomUUID()
        );
        expect(result).toEqual({ outcome: 'not_claimed', flow: null });
      });
      const result = await runWithTenantDatabaseScope(owned.db, flow.tenant, (db) =>
        new MCPOAuthPendingFlowRepository(db).claimForUser(
          flow.tenant,
          flow.userId,
          flow.stateHash,
          randomUUID()
        )
      );
      expect(result.outcome).toBe('claimed');
    });

    it('keeps direct callback discovery limited to its exact state on a non-owner connection', async () => {
      const a = await seed();
      const b = await seed();
      const result = await runWithSystemDatabaseScope(
        owned.peer,
        'test exact callback',
        async (db) => {
          const result = await new MCPOAuthPendingFlowRepository(db).claimForCallback(
            a.stateHash,
            randomUUID()
          );
          expect(
            rawRows(
              await executeRaw(
                db,
                sql`SELECT attempt_id FROM mcp_oauth_pending_flows WHERE attempt_id = ${b.attemptId}`
              )
            )
          ).toEqual([]);
          return result;
        },
        { capability: 'mcp_oauth_callback' }
      );
      expect(result.outcome).toBe('claimed');
      if (result.outcome === 'claimed') expect(result.flow.attemptId).toBe(a.attemptId);
    });

    it('clears transaction-local tenant identity on connection reuse', async () => {
      await owned.sql.begin(async (tx) => {
        await tx`SELECT set_config('agor.tenant_id', 'tenant-a', true)`;
        const [row] = await tx`SELECT current_setting('agor.tenant_id', true) AS tenant`;
        expect(row.tenant).toBe('tenant-a');
      });
      const [row] =
        await owned.sql`SELECT nullif(current_setting('agor.tenant_id', true), '') AS tenant`;
      expect(row.tenant).toBeNull();
    });
  }
);
