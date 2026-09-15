import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readManagedOAuthSchemaDigest } from './migrate';
import { seedManagedRefreshGrant } from './test-support/managed-oauth-fixture';
import {
  assertNonOwnerPostgres,
  createOwnedPostgres,
  type OwnedPostgres,
} from './test-support/owned-postgres';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed schema cohort evidence from real non-owner catalog reads',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);
    it('hashes the actual schema and exact binary ledger, not mutable tenant data or sequence values', async () => {
      await assertNonOwnerPostgres(owned.sql);
      const first = await readManagedOAuthSchemaDigest(owned.db);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      await seedManagedRefreshGrant(owned.db, 'synthetic-schema-test-secret');
      expect(await readManagedOAuthSchemaDigest(owned.peer)).toBe(first);
      await expect(
        owned.sql`UPDATE drizzle.__drizzle_migrations SET hash='tampered'`
      ).rejects.toMatchObject({ code: '42501' });
    });
    for (const kind of ['hash', 'missing', 'extra'] as const)
      it(`rejects ${kind} migration ledger drift without trusting a high watermark`, async () => {
        await owned.withMigrationLedgerDrift(kind, async () => {
          await expect(readManagedOAuthSchemaDigest(owned.db)).rejects.toThrow(
            'differs from this binary'
          );
        });
        expect(await readManagedOAuthSchemaDigest(owned.db)).toMatch(/^[a-f0-9]{64}$/);
      });
  }
);
