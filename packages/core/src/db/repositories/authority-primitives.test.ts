import { describe, expect, it, vi } from 'vitest';
import { tenantDatabaseScope } from '../tenant-context';
import { assertAuthorityFailureCode, lockTenantAuthoritySubject } from './authority-primitives';

describe('durable authority primitives', () => {
  it('accepts safe failure codes and rejects unsafe storage values', () => {
    expect(() => assertAuthorityFailureCode('exchange_owner_lost', 'Test')).not.toThrow();
    expect(() => assertAuthorityFailureCode('provider text leaked!', 'Test')).toThrow(
      'Test failure code is invalid'
    );
  });

  it('requires the exact active tenant transaction before locking', async () => {
    const execute = vi.fn(async () => []);
    const db = { execute } as never;
    await expect(lockTenantAuthoritySubject(db, 'tenant-a', 'subject')).rejects.toThrow(
      'active tenant transaction'
    );

    await expect(
      tenantDatabaseScope.run(
        {
          db,
          kind: 'tenant',
          tenantId: 'tenant-a',
          transactionActive: true,
          postCommitCallbacks: [],
          afterCommitCallbacks: [],
        },
        () => lockTenantAuthoritySubject(db, 'tenant-a', 'subject')
      )
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['an identity-only scope', { transactionActive: false }],
    ['a different tenant', { tenantId: 'tenant-b' }],
    ['a different transaction handle', { db: { execute: vi.fn() } }],
  ])('rejects %s', async (_label, override) => {
    const execute = vi.fn(async () => []);
    const db = { execute } as never;
    await expect(
      tenantDatabaseScope.run(
        {
          db,
          kind: 'tenant',
          tenantId: 'tenant-a',
          transactionActive: true,
          postCommitCallbacks: [],
          afterCommitCallbacks: [],
          ...override,
        } as never,
        () => lockTenantAuthoritySubject(db, 'tenant-a', 'subject')
      )
    ).rejects.toThrow('active tenant transaction');
    expect(execute).not.toHaveBeenCalled();
  });
});
