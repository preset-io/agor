import { describe, expect, it, vi } from 'vitest';
import { MCPCatalogIngestionWorker, resolveMCPCatalogOptions } from './mcp-catalog-ingestion';

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

describe('sync interval bounds', () => {
  /** Node's `setInterval` ceiling; beyond it a delay is rescheduled at 1 ms. */
  const MAX_TIMER_MS = 2_147_483_647;

  it('holds an oversized interval at the timer ceiling', () => {
    // 600 hours is 2,160,000,000 ms, which overflows the 32-bit timer field.
    // Node does not run it late — it reschedules at 1 ms, and because the
    // curation seed runs before the registry-sync check, that churns every
    // curated row continuously even with the sync switched off.
    expect(resolveMCPCatalogOptions({ sync_interval_hours: 600 }).intervalMs).toBe(MAX_TIMER_MS);
  });

  it.each([
    ['just under the ceiling', 596, 596 * 60 * 60 * 1000],
    ['just over the ceiling', 597, MAX_TIMER_MS],
  ])('handles a value %s', (_label, hours, expected) => {
    expect(resolveMCPCatalogOptions({ sync_interval_hours: hours }).intervalMs).toBe(expected);
  });

  it('lifts a sub-minute interval off the floor', () => {
    expect(resolveMCPCatalogOptions({ sync_interval_hours: 0.0001 }).intervalMs).toBe(60_000);
  });

  it('ignores a non-finite interval', () => {
    expect(
      resolveMCPCatalogOptions({ sync_interval_hours: Number.POSITIVE_INFINITY }).intervalMs
    ).toBeUndefined();
    expect(
      resolveMCPCatalogOptions({ sync_interval_hours: Number.NaN }).intervalMs
    ).toBeUndefined();
  });

  it('clamps at the scheduling call, not only where config is read', () => {
    // A caller constructing the worker directly never passes through
    // `resolveMCPCatalogOptions`, so the guard has to sit where `setInterval`
    // is actually called.
    const timers: number[] = [];
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      _fn: () => void,
      ms?: number
    ) => {
      timers.push(ms ?? 0);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void
    ) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const worker = new MCPCatalogIngestionWorker({} as never, {
        intervalMs: 2_160_000_000,
        initialDelayMs: 0,
      });
      worker.start();
      worker.stop();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }

    expect(timers).toEqual([MAX_TIMER_MS]);
  });
});
