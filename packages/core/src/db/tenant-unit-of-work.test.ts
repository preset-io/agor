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
});
