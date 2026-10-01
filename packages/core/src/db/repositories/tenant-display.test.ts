import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import { runWithTenantDatabaseScope, runWithTenantDatabaseTransaction } from '../tenant-scope';
import { dbTest } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import {
  TENANT_DISPLAY_LABEL_KEY,
  TENANT_DISPLAY_NAMESPACE,
  TenantDisplayRepository,
  validateTenantDisplay,
  validateTenantDisplayLabel,
} from './tenant-display';

describe('tenant display label', () => {
  it.each([
    ['Acme', 'Acme'],
    ['  Data team sandbox  ', 'Data team sandbox'],
    ['x'.repeat(80), 'x'.repeat(80)],
    ['Équipe données', 'Équipe données'],
  ])('accepts %j', (label, expected) => {
    expect(validateTenantDisplayLabel(label)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    null,
    42,
    'x'.repeat(81),
    'line\nbreak',
    'tab\there',
    'nul\u0000',
    'del\u007f',
  ])('rejects %j without echoing it', (label) => {
    expect(() => validateTenantDisplayLabel(label)).toThrow(/^Invalid tenant display label$/);
  });

  it.each([undefined, null, -1, 1.5, Infinity, '100'])(
    'requires a signed integer iat: %s',
    (iat) => {
      expect(() => validateTenantDisplay('Acme', iat)).toThrow();
    }
  );

  const observe = (db: Database, tenant: string) => (label: string, assertion_issued_at: number) =>
    runWithTenantDatabaseTransaction(db, tenant, (scoped) =>
      new TenantDisplayRepository(scoped).observeVerifiedLaunch({ label, assertion_issued_at })
    );
  const read = (db: Database, tenant: string) =>
    runWithTenantDatabaseScope(db, tenant, (scoped) => new TenantDisplayRepository(scoped).find());
  const writeRaw = (db: Database, value: string) =>
    new AppVariableRepository(db).set({
      namespace: TENANT_DISPLAY_NAMESPACE,
      key: TENANT_DISPLAY_LABEL_KEY,
      value,
    });

  dbTest('orders observations by signed iat; equal iat keeps the first', async ({ db }) => {
    const launch = observe(db, 'tenant-a');
    await expect(read(db, 'tenant-a')).resolves.toBeNull();
    await launch('Acme', 100);
    await expect(read(db, 'tenant-a')).resolves.toEqual({
      label: 'Acme',
      assertion_issued_at: 100,
    });
    await launch('Stale', 99);
    await launch('Same second', 100);
    await expect(read(db, 'tenant-a')).resolves.toMatchObject({ label: 'Acme' });
    await launch('Renamed', 101);
    await expect(read(db, 'tenant-a')).resolves.toMatchObject({ label: 'Renamed' });
  });

  dbTest('rejects untransactional writes', async ({ db }) => {
    await runWithTenantDatabaseScope(db, 'tenant-a', (scoped) =>
      expect(
        new TenantDisplayRepository(scoped).observeVerifiedLaunch({
          label: 'Acme',
          assertion_issued_at: 100,
        })
      ).rejects.toThrow('active tenant transaction')
    );
  });

  dbTest.for([
    '{invalid',
    'null',
    JSON.stringify({ tenant_id: 'tenant-a', label: '', assertion_issued_at: 999 }),
    JSON.stringify({ tenant_id: 'tenant-a', label: 'Acme', assertion_issued_at: 'later' }),
  ])(
    'reads a corrupt row as absent and repairs it on the next launch: %s',
    async (value, { db }) => {
      await writeRaw(db, value);
      await expect(read(db, 'tenant-a')).resolves.toBeNull();
      await observe(db, 'tenant-a')('Acme', 100);
      await expect(read(db, 'tenant-a')).resolves.toEqual({
        label: 'Acme',
        assertion_issued_at: 100,
      });
    }
  );

  dbTest('does not reuse an imported observation bound to another tenant', async ({ db }) => {
    await writeRaw(
      db,
      JSON.stringify({ tenant_id: 'source-tenant', label: 'Source', assertion_issued_at: 999 })
    );
    await expect(read(db, 'destination-tenant')).resolves.toBeNull();
    await observe(db, 'destination-tenant')('Destination', 100);
    await expect(read(db, 'destination-tenant')).resolves.toMatchObject({
      label: 'Destination',
    });
  });
});
