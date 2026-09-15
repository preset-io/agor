/** ACK HTTP is a fixture; the receipt-selection/CAS boundary uses actual non-owner PostgreSQL. */
import {
  executeRaw,
  runWithTenantDatabaseScope,
  sql,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import { describe, expect, it, vi } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import { createOwnedPostgres } from '../../../../packages/core/src/db/test-support/owned-postgres';
import { createManagedOAuthAcknowledger } from './mcp-oauth-managed-ack';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed ACK local delivery proof',
  () => {
    it('retries a lost ACK, stops re-ACKing success, and never marks a later receipt with a stale ACK', async () => {
      const owned = await createOwnedPostgres();
      try {
        const f = await seedManagedRefreshGrant(owned.db, 'synthetic-ack-master');
        const list = () =>
          runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
            new UserMCPOAuthTokenRepository(db).listManagedReceiptsForAcknowledgement(f.tenant)
          );
        const request = vi.fn(async (input: Parameters<ManagedMCPOAuthClient['request']>[0]) => {
          await input.assertCurrent();
          return input.schema.parse({ protocol_version: 1, acknowledged: true });
        });
        const acknowledge = createManagedOAuthAcknowledger({
          db: owned.db,
          sender: { request } as unknown as ManagedMCPOAuthClient,
          assertOwner: () => {},
        });
        request.mockRejectedValueOnce(new Error('synthetic ACK response lost'));
        await expect(acknowledge(f.commit.metadata)).rejects.toThrow('response lost');
        expect(await list()).toHaveLength(1);
        await acknowledge(f.commit.metadata);
        expect(await list()).toEqual([]);
        await acknowledge(f.commit.metadata);
        expect(await list()).toEqual([]);
        const next = {
          ...f.commit.metadata,
          operation_id: 'new-operation',
          receipt_id: 'new-receipt',
          signed_receipt: 'synthetic.new.receipt',
        };
        await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          executeRaw(
            db,
            sql`
        UPDATE user_mcp_oauth_tokens SET managed_metadata=${JSON.stringify(next)}::jsonb
        WHERE user_id=${f.user} AND mcp_server_id=${f.server}`
          )
        );
        await acknowledge(f.commit.metadata);
        expect(await list()).toEqual([next]);
        await expect(
          runWithTenantDatabaseScope(owned.peer, 'foreign-tenant', (db) =>
            new UserMCPOAuthTokenRepository(db).markManagedReceiptAcknowledged(next)
          )
        ).rejects.toThrow('scope mismatch');
        await acknowledge(next);
        expect(await list()).toEqual([]);
        const token = await runWithTenantDatabaseScope(owned.db, f.tenant, (db) =>
          new UserMCPOAuthTokenRepository(db).getManagedMetadata(f.user, f.server)
        );
        expect(token).toEqual({ ...next, receipt_acknowledged: true });
        expect(token?.use_authorization).toBe(f.commit.metadata.use_authorization);
      } finally {
        await owned.dispose();
      }
    }, 120000);
  }
);
