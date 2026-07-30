/**
 * Unit coverage for the portability insert ordering. The import order must be the
 * exact reverse of the deletion (child-first) order, which guarantees every
 * foreign-key parent is inserted before any row that references it.
 */

import { describe, expect, it } from 'vitest';
import { buildTenantDeletionManifest } from './tenant-deletion-manifest';
import {
  buildTenantInsertOrder,
  derivedImperativeTableNames,
  tenantPortabilityTableNames,
} from './tenant-portability-manifest';

describe('buildTenantInsertOrder', () => {
  it('is the exact reverse of the deletion (child-first) order', () => {
    const deletion = buildTenantDeletionManifest().map((entry) => entry.name);
    const insert = buildTenantInsertOrder().map((entry) => entry.name);
    expect(insert).toEqual([...deletion].reverse());
  });

  it('scopes every table by tenant_id', () => {
    for (const table of buildTenantInsertOrder()) {
      expect(table.tenantColumn).toBe('tenant_id');
    }
  });

  it('covers exactly the compiled tenant tables', () => {
    const insertNames = buildTenantInsertOrder()
      .map((entry) => entry.name)
      .sort();
    expect(insertNames).toEqual(tenantPortabilityTableNames());
  });

  it('does not move derived imperative tables as rows', () => {
    const insertNames = new Set(buildTenantInsertOrder().map((entry) => entry.name));
    for (const derived of derivedImperativeTableNames()) {
      expect(insertNames.has(derived)).toBe(false);
    }
  });
});
