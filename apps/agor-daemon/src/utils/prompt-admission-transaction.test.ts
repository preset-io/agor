import {
  getCurrentTenantDatabaseScope,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  promptAdmissionSqlState,
  runPromptAdmissionTransaction,
} from './prompt-admission-transaction.js';

vi.mock('@agor/core/db', () => ({
  assertTenantWritable: vi.fn(),
  getCurrentTenantDatabaseScope: vi.fn(),
  isPostgresDatabaseHandle: vi.fn(() => true),
  runWithTenantDatabaseTransaction: vi.fn(),
}));
const db = {} as TenantScopeAwareDatabase;
const scoped = {} as TenantScopedDatabase;
const wrapped = (code: string) =>
  new Error('private SQL and params', {
    cause: new Error('repository wrapper', { cause: { code, detail: 'private detail' } }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentTenantDatabaseScope).mockReturnValue(undefined);
  vi.mocked(isPostgresDatabaseHandle).mockReturnValue(true);
  vi.mocked(runWithTenantDatabaseTransaction).mockImplementation(async (_db, _tenant, work) =>
    work(scoped)
  );
});

describe('prompt admission transaction', () => {
  it.each(['40P01', '40001'])('restarts the whole unit, at most twice, for %s', async (code) => {
    const work = vi.fn().mockRejectedValueOnce(wrapped(code)).mockResolvedValue('task');
    await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).resolves.toBe('task');
    expect(work).toHaveBeenCalledTimes(2);
    expect(runWithTenantDatabaseTransaction).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(runWithTenantDatabaseTransaction).mock.calls.every((call) => call[1] === 'tenant-a')
    ).toBe(true);
    work.mockReset().mockRejectedValue(wrapped(code));
    await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).rejects.toThrow(
      'Could not confirm'
    );
    expect(work).toHaveBeenCalledTimes(3);
  });

  it.each(['55P03', '57014', '42501', '25P02', '25P03', '08006', '40003', '23505'])(
    'does not replay %s and does not expose raw diagnostics',
    async (code) => {
      const original = wrapped(code);
      const work = vi.fn().mockRejectedValue(original);
      const failure = await runPromptAdmissionTransaction(db, 'tenant-a', work).catch(
        (error: Error) => error
      );
      expect(work).toHaveBeenCalledOnce();
      expect(failure.cause).toBe(original);
      expect(JSON.stringify(failure)).not.toMatch(/private|SQL|params|detail/);
    }
  );

  it('does not retry uncertain commit or post-commit errors', async () => {
    vi.mocked(runWithTenantDatabaseTransaction).mockImplementation(async (_db, _tenant, work) => {
      await work(scoped);
      throw wrapped('40001');
    });
    const work = vi.fn().mockResolvedValue('committed task');
    await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).rejects.toThrow(
      'Could not confirm'
    );
    expect(work).toHaveBeenCalledOnce();
  });

  it('does not restart or obscure a caller-owned transaction', async () => {
    vi.mocked(getCurrentTenantDatabaseScope).mockReturnValue({
      kind: 'tenant',
      db: scoped,
      tenantId: 'tenant-a',
      transactionActive: true,
      postCommitCallbacks: [],
      afterCommitCallbacks: [],
    });
    const original = wrapped('40P01');
    const work = vi.fn().mockRejectedValue(original);
    await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).rejects.toBe(original);
    expect(work).toHaveBeenCalledOnce();
  });

  it('preserves SQLite and authorization failures without replay', async () => {
    for (const original of [new Forbidden('denied'), new Error('CONNECTION_CLOSED')]) {
      const work = vi.fn().mockRejectedValue(original);
      await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).rejects.toBe(original);
      expect(work).toHaveBeenCalledOnce();
    }
    vi.mocked(isPostgresDatabaseHandle).mockReturnValue(false);
    const original = wrapped('40001');
    const work = vi.fn().mockRejectedValue(original);
    await expect(runPromptAdmissionTransaction(db, 'tenant-a', work)).rejects.toBe(original);
    expect(work).toHaveBeenCalledOnce();
  });

  it('bounds cause traversal and never classifies by query/message text', () => {
    const cycle = { cause: {} };
    cycle.cause = cycle;
    expect(promptAdmissionSqlState(cycle)).toBeUndefined();
    expect(promptAdmissionSqlState(new Error('40P01 deadlock detected'))).toBeUndefined();
    expect(promptAdmissionSqlState({ code: 'SQLITE_BUSY' })).toBeUndefined();
    expect(promptAdmissionSqlState(wrapped('40P01'))).toBe('40P01');
  });
});
