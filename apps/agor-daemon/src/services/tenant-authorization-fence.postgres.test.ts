import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Params } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'tenant authorization fence (PostgreSQL)',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'tenant-authority-fence-a',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'tenant-authority-fence-b',
      });
    }, 60_000);

    afterAll(async () => {
      await Promise.all([
        (rawA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (rawB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    it('serializes service-account and actorless authority writers on the same tenant', async () => {
      const tenantId = `authorization-fence-${generateId()}`;
      const firstAcquired = deferred();
      const releaseFirst = deferred();
      const serviceParams = {
        tenant: { tenant_id: tenantId, source: 'service' },
        user: { user_id: 'executor-service', role: 'service', _isServiceAccount: true },
      } as unknown as Params;

      const first = runWithTenantDatabaseTransaction(dbA, tenantId, async (operationDb) => {
        await lockTenantAuthorizationFence(operationDb, serviceParams);
        firstAcquired.resolve();
        await releaseFirst.promise;
      });
      await firstAcquired.promise;

      let secondAcquired = false;
      const second = runWithTenantDatabaseTransaction(dbB, tenantId, async (operationDb) => {
        await lockTenantAuthorizationFence(operationDb);
        secondAcquired = true;
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondAcquired).toBe(false);
      } finally {
        releaseFirst.resolve();
      }

      await Promise.all([first, second]);
      expect(secondAcquired).toBe(true);
    });
  }
);
