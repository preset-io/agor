import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  initializeDatabase,
  isPostgresDatabase,
  runWithTenantDatabaseScope,
  TenantAgenticToolSettingsRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAgenticToolEnabledForTenant } from './tenant-agentic-tool-validation';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'tenant-agentic-tool-validation-test-secret';
});

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'isAgenticToolEnabledForTenant (PostgreSQL)',
  () => {
    let rawDb: Database;
    let guardedDb: ReturnType<typeof createTenantScopedDatabaseProxy>;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      guardedDb = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'PostgreSQL prompt validation test db',
      });
    });

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('reads the requested tenant disabled setting without leaking another tenant', async () => {
      const enabledTenant = `prompt-enabled-${Date.now()}`;
      const disabledTenant = `prompt-disabled-${Date.now()}`;
      await runWithTenantDatabaseScope(guardedDb, disabledTenant, (tenantDb) =>
        new TenantAgenticToolSettingsRepository(tenantDb).patch('codex', { enabled: false })
      );

      await expect(isAgenticToolEnabledForTenant(guardedDb, disabledTenant, 'codex')).resolves.toBe(
        false
      );
      await expect(isAgenticToolEnabledForTenant(guardedDb, enabledTenant, 'codex')).resolves.toBe(
        true
      );
    });
  }
);
