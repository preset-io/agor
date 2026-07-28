import { describe, expect, it } from 'vitest';
import { resolveMCPCatalogOptions } from './mcp-catalog-ingestion';

describe('resolveMCPCatalogOptions', () => {
  it('syncs the registry when the operator has expressed no preference', () => {
    expect(resolveMCPCatalogOptions(undefined)).toEqual({ registrySyncEnabled: true });
    expect(resolveMCPCatalogOptions({})).toEqual({ registrySyncEnabled: true });
  });

  it('lets an air-gapped install turn off the outbound registry sync', () => {
    // Curation still seeds from the repo-shipped file; only the network half stops.
    expect(resolveMCPCatalogOptions({ registry_sync_enabled: false })).toEqual({
      registrySyncEnabled: false,
    });
  });

  it('lets an operator disable auth probing without disabling the sync', () => {
    expect(resolveMCPCatalogOptions({ probe_budget: 0 })).toEqual({
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
