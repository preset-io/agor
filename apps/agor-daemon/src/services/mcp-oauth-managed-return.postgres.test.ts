/** Real non-owner/RLS projection boundary; worker ticket verification is covered by the paired suite. */
import {
  executeRaw,
  MCPOAuthPendingFlowRepository,
  runWithTenantDatabaseScope,
  sql,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import { createOwnedPostgres } from '../../../../packages/core/src/db/test-support/owned-postgres';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'completed managed return authority under real RLS',
  () => {
    let owned: Awaited<ReturnType<typeof createOwnedPostgres>>;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 60000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    async function completed() {
      const f = await seedManagedRefreshGrant(owned.db, 'synthetic-return-master');
      const read = () =>
        runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          new MCPOAuthPendingFlowRepository(db).getManagedForTransaction(
            f.tenant,
            f.user,
            f.commit.metadata.transaction_id
          )
        );
      expect((await read())?.status).toBe('succeeded');
      return { ...f, read };
    }
    it('retains original nonce/owner/transaction context without opening any token', async () => {
      const f = await completed();
      const record = await f.read();
      expect(record?.sealedMaterial).toBeNull();
      expect(record?.managedMetadata?.owner).toEqual(f.owner);
      expect(record?.managedMetadata?.prepare_request.client_nonce_hash).toBe('c'.repeat(64));
    });
    it.each([
      'deleted',
      'ambiguous',
      'transaction',
      'owner',
      'binding',
      'expired',
      'superseded',
      'canceled',
      'empty-access',
    ] as const)('denies %s original grant context', async (change) => {
      const f = await completed();
      await runWithTenantDatabaseScope(owned.db, f.tenant, async (db) => {
        if (change === 'canceled')
          await executeRaw(
            db,
            sql`UPDATE mcp_oauth_pending_flows SET status='failed',failure_code='attempt_canceled' WHERE attempt_id=${f.owner.attempt_id}`
          );
        if (change === 'empty-access')
          await executeRaw(
            db,
            sql`UPDATE user_mcp_oauth_tokens SET oauth_access_token='' WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          );
        if (change === 'deleted')
          await executeRaw(
            db,
            sql`DELETE FROM user_mcp_oauth_tokens WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          );
        if (change === 'ambiguous')
          await executeRaw(
            db,
            sql`UPDATE user_mcp_oauth_tokens SET refresh_status='ambiguous' WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          );
        if (change === 'transaction')
          await executeRaw(
            db,
            sql`UPDATE user_mcp_oauth_tokens SET managed_metadata=jsonb_set(managed_metadata,'{transaction_id}','"other-transaction"') WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          );
        if (change === 'owner')
          await executeRaw(
            db,
            sql`UPDATE user_mcp_oauth_tokens SET managed_metadata=jsonb_set(managed_metadata,'{owner,attempt_id}','"other-attempt"') WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          );
        if (change === 'binding')
          await executeRaw(
            db,
            sql`UPDATE mcp_oauth_pending_flows SET config_fingerprint=${'d'.repeat(64)}, managed_metadata=jsonb_set(jsonb_set(managed_metadata,'{owner,config_fingerprint}',to_jsonb(${'d'.repeat(64)}::text)),'{prepare_request,owner,config_fingerprint}',to_jsonb(${'d'.repeat(64)}::text)) WHERE attempt_id=${f.owner.attempt_id}`
          );
        if (change === 'expired')
          await executeRaw(
            db,
            sql`UPDATE mcp_oauth_pending_flows SET expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=${f.owner.attempt_id}`
          );
        if (change === 'superseded')
          await executeRaw(
            db,
            sql`UPDATE mcp_oauth_pending_flows SET is_current=false WHERE attempt_id=${f.owner.attempt_id}`
          );
      });
      expect(await f.read()).toBeNull();
    });
    it('does not resolve the original transaction under another authenticated tenant or caller', async () => {
      const f = await completed();
      const foreign = await completed();
      expect(
        await runWithTenantDatabaseScope(owned.db, foreign.tenant, (db) =>
          new MCPOAuthPendingFlowRepository(db).getManagedForTransaction(
            foreign.tenant,
            foreign.user,
            f.commit.metadata.transaction_id
          )
        )
      ).toBeNull();
      expect(
        await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          new MCPOAuthPendingFlowRepository(db).getManagedForTransaction(
            f.tenant,
            foreign.user,
            f.commit.metadata.transaction_id
          )
        )
      ).toBeNull();
    });
  }
);
