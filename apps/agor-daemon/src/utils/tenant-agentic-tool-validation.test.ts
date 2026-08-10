import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  MissingTenantDatabaseScopeError,
  runWithTenantDatabaseScope,
  TenantAgenticToolSettingsRepository,
} from '@agor/core/db';
import { beforeAll, describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { isAgenticToolEnabledForTenant } from './tenant-agentic-tool-validation';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'tenant-agentic-tool-validation-test-secret';
});

describe('isAgenticToolEnabledForTenant', () => {
  dbTest('opens the guarded short tenant scope and observes disabled policy', async ({ db }) => {
    const guarded = createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'prompt validation test db',
    });
    await runWithTenantDatabaseScope(guarded, 'disabled-tenant', (tenantDb) =>
      new TenantAgenticToolSettingsRepository(tenantDb).patch('codex', { enabled: false })
    );

    await expect(isAgenticToolEnabledForTenant(guarded, 'disabled-tenant', 'codex')).resolves.toBe(
      false
    );
    await expect(isTenantAgenticToolEnabled('codex', guarded)).rejects.toBeInstanceOf(
      MissingTenantDatabaseScopeError
    );
  });
});
