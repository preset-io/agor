/** Actual DB/acquisition boundary; adapter and grant validator are fixtures, not full signed-egress proof. */
import {
  executeRaw,
  runWithTenantDatabaseScope,
  sql,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import { ManagedMCPOAuthOperationError } from '@agor/core/tools/mcp/managed-oauth-client';
import type { MCPManagedOAuthRefreshAdapter } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import { createOwnedPostgres } from '../../../../packages/core/src/db/test-support/owned-postgres';
import { acquireMCPOAuthGrant } from './mcp-oauth-use';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')('managed backoff acquisition', () => {
  it('retains the same bounded grant across certified rejection and a second replica without another dispatch', async () => {
    const owned = await createOwnedPostgres();
    const master = 'synthetic-managed-backoff-master';
    const original = process.env.AGOR_MASTER_SECRET;
    process.env.AGOR_MASTER_SECRET = master;
    try {
      const f = await seedManagedRefreshGrant(owned.db, master);
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`
        UPDATE user_mcp_oauth_tokens SET oauth_token_expires_at=clock_timestamp()+interval '45 seconds'
        WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        )
      );
      const execute = vi.fn<MCPManagedOAuthRefreshAdapter['execute']>(async ({ request }) => {
        throw new ManagedMCPOAuthOperationError({
          protocol_version: 1,
          operation_id: request.operation_id,
          owner: request.owner,
          claim: request.claim,
          status: 'rejected_non_consuming',
          failure_code: 'provider_rate_limited',
          sequence: request.sequence,
          next_sequence: String(BigInt(request.sequence) + 1n),
          retry_after_ms: 60000,
        });
      });
      const deps = {
        db: owned.db,
        tenantId: f.tenant,
        userId: f.user,
        mcpServerId: f.server,
        validateGrant: () => true,
        managed: { execute, acknowledge: async () => {} },
      };
      const first = await acquireMCPOAuthGrant(deps);
      const second = await acquireMCPOAuthGrant({ ...deps, db: owned.peer });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(first?.oauth_access_token).toBe(f.commit.tokens.access_token);
      expect(first?.managed_metadata?.use_authorization).toBe(f.commit.metadata.use_authorization);
      expect(second).toEqual(first);
      const denied = { ...deps, validateGrant: () => false };
      await expect(acquireMCPOAuthGrant(denied)).rejects.toThrow();
      await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
        executeRaw(
          db,
          sql`
        UPDATE user_mcp_oauth_tokens SET oauth_token_expires_at=clock_timestamp()-interval '1 second'
        WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
        )
      );
      await expect(acquireMCPOAuthGrant(deps)).rejects.toThrow('retry deferred');
      expect(execute).toHaveBeenCalledTimes(1);
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        expect(
          (await new UserMCPOAuthTokenRepository(db).getToken(f.user, f.server))?.refresh_generation
        ).toBe(1);
      });
    } finally {
      if (original === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = original;
      await owned.dispose();
    }
  }, 120000);
});
