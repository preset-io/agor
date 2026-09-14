import type { AgorConfig } from '@agor/core/config';
import {
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapSuperadminUsers } from '../register-services.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'bootstrap superadmin authority (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('promotes in a fenced static-tenant transaction and rejects ambiguous tenancy', async () => {
      const tenantId = `bootstrap-superadmin-${generateId()}`;
      const user = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new UsersRepository(scoped).create({
          email: `${generateId()}@bootstrap-superadmin.test`,
          role: 'admin',
        })
      );
      const config = {
        multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
        execution: {
          allow_superadmin: true,
          bootstrap_superadmin_users: [user.user_id],
        },
      } satisfies AgorConfig;

      await bootstrapSuperadminUsers(config, db, true);
      await expect(
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new UsersRepository(scoped).findById(user.user_id)
        )
      ).resolves.toMatchObject({ role: 'superadmin' });

      await expect(
        bootstrapSuperadminUsers(
          {
            ...config,
            multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          },
          db,
          true
        )
      ).rejects.toThrow(/requires multi_tenancy\.mode=static/);
    });
  }
);
