/**
 * PostgreSQL integration proof for tenant-stamped external identity projection.
 *
 * Run with, e.g.:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run \
 *     src/db/repositories/user-external-identities.postgres.test.ts
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserExternalIdentity, UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { deleteFrom, insert, isPostgresDatabase, select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import * as pg from '../schema.postgres';
import { runWithTenantDatabaseScope, runWithTenantDatabaseTransaction } from '../tenant-scope';
import { UserExternalIdentitiesRepository } from './user-external-identities';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

async function closePostgresDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'external identity projection (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      if (db) await closePostgresDatabase(db);
    });

    it('stamps the scoped tenant on JIT-style inserts and hides the projection from other tenants', async () => {
      const tenantA = `external-identity-a-${generateId()}`;
      const tenantB = `external-identity-b-${generateId()}`;
      const userId = generateId() as UserID;
      const identity: UserExternalIdentity = {
        key: 'a'.repeat(64),
        provider: 'external-launch-test',
        issuer: `https://issuer.example.test/${generateId()}`,
        subject: generateId(),
        email: `${generateId()}@example.test`,
        name: 'External Identity Test',
        last_login_at: new Date().toISOString(),
      };
      const now = new Date();

      await runWithTenantDatabaseTransaction(db, tenantA, async (scoped) => {
        // This intentionally mirrors launch-auth: tenant_id is omitted and the
        // tenant-aware insert wrapper stamps it from the trusted DB scope.
        await insert(scoped, pg.users)
          .values({
            user_id: userId,
            created_at: now,
            updated_at: now,
            email: identity.email!,
            password: 'not-used-for-external-auth',
            name: identity.name,
            emoji: '👤',
            role: 'member',
            onboarding_completed: false,
            must_change_password: false,
            data: { external_identities: [identity] },
          })
          .run();

        const repository = new UserExternalIdentitiesRepository(scoped);
        await repository.lockProvisioningKey(`identity:${identity.key}`);
        await repository.bind(userId, identity, now);

        expect(
          await select(scoped).from(pg.users).where(eq(pg.users.user_id, userId)).one()
        ).toMatchObject({
          tenant_id: tenantA,
          user_id: userId,
        });
        expect(await repository.findByKey(identity.key)).toMatchObject({
          tenant_id: tenantA,
          user_id: userId,
        });
      });

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          await select(scoped).from(pg.users).where(eq(pg.users.user_id, userId)).one()
        ).toBeNull();
        expect(
          await select(scoped)
            .from(pg.userExternalIdentities)
            .where(eq(pg.userExternalIdentities.identity_key, identity.key))
            .one()
        ).toBeNull();
      });

      await runWithTenantDatabaseTransaction(db, tenantA, async (scoped) => {
        await deleteFrom(scoped, pg.users).where(eq(pg.users.user_id, userId)).run();
      });
    });
  }
);
