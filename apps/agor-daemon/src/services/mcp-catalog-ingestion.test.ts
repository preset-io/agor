import { describe, expect, it } from 'vitest';
import { resolveMCPCatalogOptions } from './mcp-catalog-ingestion';

describe('resolveMCPCatalogOptions', () => {
  it('leaves the outbound registry sync off unless an operator opts in', () => {
    // Phase 1 renders only curated entries, so mirroring ~18,000 registry rows
    // would be outbound traffic for data nobody can see.
    expect(resolveMCPCatalogOptions(undefined)).toEqual({ registrySyncEnabled: false });
    expect(resolveMCPCatalogOptions({})).toEqual({ registrySyncEnabled: false });
    expect(resolveMCPCatalogOptions({ registry_sync_enabled: false })).toEqual({
      registrySyncEnabled: false,
    });
  });

  it('enables the sync when the operator asks for it', () => {
    expect(resolveMCPCatalogOptions({ registry_sync_enabled: true })).toEqual({
      registrySyncEnabled: true,
    });
  });

  it('lets an operator disable auth probing without disabling the sync', () => {
    expect(resolveMCPCatalogOptions({ registry_sync_enabled: true, probe_budget: 0 })).toEqual({
      registrySyncEnabled: true,
      probeBudget: 0,
    });
  });

  it('converts the sync interval from hours to milliseconds', () => {
    expect(resolveMCPCatalogOptions({ sync_interval_hours: 12 }).intervalMs).toBe(
      12 * 60 * 60 * 1000
    );
  });

  it('ignores nonsensical values rather than scheduling a runaway loop', () => {
    expect(resolveMCPCatalogOptions({ sync_interval_hours: 0 }).intervalMs).toBeUndefined();
    expect(resolveMCPCatalogOptions({ sync_interval_hours: -1 }).intervalMs).toBeUndefined();
    expect(resolveMCPCatalogOptions({ probe_budget: -5 }).probeBudget).toBeUndefined();
    expect(resolveMCPCatalogOptions({ registry_url: '   ' }).registryUrl).toBeUndefined();
  });

  it('accepts a registry URL override', () => {
    expect(resolveMCPCatalogOptions({ registry_url: ' https://registry.internal ' })).toMatchObject(
      { registryUrl: 'https://registry.internal' }
    );
  });
});
