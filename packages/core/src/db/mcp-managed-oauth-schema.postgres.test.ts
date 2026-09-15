import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyMigrationWatermark, readManagedOAuthSchemaDigest } from './migrate';
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
    it('presents a newer watermark to the already-existing main-baseline daemon startup fence', async () => {
      // Main 4b1905e2's journal ends at 0109/1789344000003. Its existing
      // setup/database.ts rejects dbAheadOfBinary before seeding/services.
      // This is a startup fence, NOT revocation of an already-running old pool.
      const [row] =
        await owned.sql`SELECT MAX(created_at) AS latest FROM drizzle.__drizzle_migrations`;
      const latest = Number(row.latest);
      expect(latest).toBe(1789344000006);
      expect(
        classifyMigrationWatermark(
          [{ tag: '0109_branch_cleanup_policy', when: 1789344000003 }],
          latest
        )
      ).toMatchObject({ dbAheadOfBinary: true, hasPending: false });
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
