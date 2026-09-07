/** PostgreSQL proof for Claude credential side-effect admission. */

import { randomUUID } from 'node:crypto';
import {
  acquireTenantWriteGate,
  createDatabase,
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  initializeDatabase,
  isPostgresDatabase,
  type RawDatabase,
  releaseTenantWriteGate,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantWriteAdmissionAroundHook } from '../utils/tenant-db-scope.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Claude credential write admission (PostgreSQL)',
  () => {
    let raw: RawDatabase;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      if (!isPostgresDatabase(raw)) throw new Error('PostgreSQL test requires PostgreSQL');
      db = createTenantScopedDatabaseProxy(raw, {
        requireScope: true,
        label: 'Claude credential admission test',
      });
    });

    afterAll(async () => {
      await (raw as RawDatabase & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('mutates no file while frozen and releases the admission transaction before handler I/O', async () => {
      const tenantId = `claude-auth-gate-${randomUUID()}`;
      const gate = await acquireTenantWriteGate(raw, tenantId, {
        holder: 'claude-auth-test',
        reason: 'prove credential files do not mutate while frozen',
      });
      const hook = createTenantWriteAdmissionAroundHook(db);
      const context = {
        path: 'claude-auth/oauth',
        method: 'create',
        params: { tenant: { tenant_id: tenantId, source: 'explicit' } },
      } as HookContext;
      let filesystemMutations = 0;
      const executorIo = async () => {
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        filesystemMutations += 1;
      };

      try {
        await expect(hook(context, executorIo)).rejects.toMatchObject({ code: 503 });
        expect(filesystemMutations).toBe(0);
      } finally {
        await releaseTenantWriteGate(raw, tenantId, { generation: gate.generation });
      }

      await expect(hook(context, executorIo)).resolves.toBeUndefined();
      expect(filesystemMutations).toBe(1);
    });
  }
);
