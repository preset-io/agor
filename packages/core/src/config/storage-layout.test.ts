import { describe, expect, it } from 'vitest';
import { getManagedStorageSegments } from './storage-layout.js';

describe('getManagedStorageSegments', () => {
  it('places single-tenant data directly beneath the base', () => {
    expect(getManagedStorageSegments('uploads', { tenantSeparated: false })).toEqual(['uploads']);
  });

  it('places tenant data beneath the canonical tenant-first namespace', () => {
    expect(
      getManagedStorageSegments('uploads', {
        tenantId: 'tenant-a',
        tenantSeparated: true,
      })
    ).toEqual(['tenants', 'tenant-a', 'uploads']);
  });

  it('rejects missing or unsafe tenant and namespace segments', () => {
    expect(() => getManagedStorageSegments('uploads', { tenantSeparated: true })).toThrow(
      /tenant id/i
    );
    expect(() =>
      getManagedStorageSegments('uploads', {
        tenantId: '../tenant-b',
        tenantSeparated: true,
      })
    ).toThrow(/tenant id/i);
    expect(() => getManagedStorageSegments('../uploads', { tenantSeparated: false })).toThrow(
      /namespace/i
    );
  });
});
