import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayDeliveryLoop } from './gateway-delivery-loop.js';

interface Ref {
  tenant_id: string;
  id: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('GatewayDeliveryLoop tenant-context isolation', () => {
  let loop: GatewayDeliveryLoop<Ref> | undefined;

  afterEach(async () => {
    if (loop) await loop.stop();
    loop = undefined;
    vi.restoreAllMocks();
  });

  it('wake armed from one tenant does not wedge the cross-tenant scan', async () => {
    // gateway.ts arms worker.wake() from inside a tenant's message-routing
    // request (runWithTenantContext). The wake-armed timer must not inherit that
    // tenant's identity, or the loop's per-tenant runWithTenantContext throws
    // "Cannot enter tenant context" for every OTHER tenant and wedges delivery.
    const refs: Ref[] = [
      { tenant_id: 'tenant-b', id: 'b1' },
      { tenant_id: 'tenant-c', id: 'c1' },
    ];
    let scans = 0;
    const seenDuringProcess: Array<string | undefined> = [];
    const seenDuringPurge: Array<string | undefined> = [];
    // The purge pass runs after processing, so waiting on it implies both.
    const scanSettled = deferred<void>();

    loop = new GatewayDeliveryLoop<Ref>({
      area: 'test.gateway-delivery-loop',
      scanBatchSize: 10,
      maxConcurrency: 2,
      shutdownTimeoutMs: 1_000,
      // Keep the initial start() timer far out so only the wake-armed timer runs
      // the first scan; wake() clears and replaces it.
      recoveryIntervalMs: 60_000,
      random: () => 0.9,
      discover: async () => {
        scans += 1;
        return scans === 1 ? [...refs] : [];
      },
      lane: (ref) => ref.id,
      process: async (ref) => {
        seenDuringProcess.push(getCurrentTenantId());
      },
      purge: async () => {
        seenDuringPurge.push(getCurrentTenantId());
        if (seenDuringPurge.length === refs.length) scanSettled.resolve();
      },
    });

    loop.start();
    // Arm the wake while a foreign tenant's identity is ambient.
    runWithTenantContext('tenant-a', () => loop?.wake());

    await Promise.race([
      scanSettled.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);

    // Both other tenants are processed, each under its OWN identity — not the
    // armer's "tenant-a". Reverting the shed in schedule() leaves the timer
    // under tenant-a, runWithTenantContext('tenant-b') throws before process
    // runs, and seenDuringProcess stays empty, failing this assertion.
    expect(seenDuringProcess.slice().sort()).toEqual(['tenant-b', 'tenant-c']);
    expect(seenDuringProcess).not.toContain('tenant-a');
    // The per-tenant purge pass runs cleanly for each tenant too.
    expect(seenDuringPurge.slice().sort()).toEqual(['tenant-b', 'tenant-c']);
  });
});
