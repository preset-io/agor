import { describe, expect, it } from 'vitest';
import type { Database } from './client';
import { getCurrentTenantDatabaseScope, runWithTenantContext } from './tenant-scope';
import { bindRepositoryToTenantUnitOfWork } from './tenant-unit-of-work';

describe('bindRepositoryToTenantUnitOfWork', () => {
  it('opens a fresh short DB scope per repository call', async () => {
    const db = { run: () => undefined } as unknown as Database;
    const scopes: unknown[] = [];
    const repo = bindRepositoryToTenantUnitOfWork(db as never, {
      async read() {
        scopes.push(getCurrentTenantDatabaseScope());
      },
    });

    await runWithTenantContext('tenant-a', async () => {
      await repo.read();
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      await repo.read();
    });

    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toBeTruthy();
    expect(scopes[1]).toBeTruthy();
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('pins an explicitly bound tenant where ambient identity is absent', async () => {
    // A deferred writer — a renewal timer, a failure handler, a callback
    // projection — is not reliably inside the request's tenant identity, and a
    // scope opened with no tenant does not satisfy the database scope guard.
    // Binding the tenant is what makes the handle safe to call from there.
    const db = { run: () => undefined } as unknown as Database;
    const tenants: Array<string | undefined> = [];
    const repo = bindRepositoryToTenantUnitOfWork(
      db as never,
      {
        async read() {
          const scope = getCurrentTenantDatabaseScope();
          tenants.push(scope?.kind === 'tenant' ? scope.tenantId : undefined);
        },
      },
      'tenant-sealed'
    );

    await repo.read();
    // An ambient identity does not override the pinned one.
    await runWithTenantContext('tenant-sealed', () => repo.read());

    expect(tenants).toEqual(['tenant-sealed', 'tenant-sealed']);
  });
});
