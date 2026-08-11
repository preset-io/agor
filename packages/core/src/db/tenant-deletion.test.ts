import { describe, expect, it, vi } from 'vitest';
import {
  assertNoRemainingTenantRows,
  assertValidTenantId,
  deleteTenantData,
  InvalidTenantIdError,
  TenantDeletionUnsupportedError,
  TenantDeletionVerificationError,
} from './tenant-deletion';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { dbTest } from './test-helpers';

describe('assertValidTenantId', () => {
  it.each(['acme-corp', 'default', '0192f0c4-6f1e-7a2b-9c3d-4e5f60718293', 'tenant_42'])(
    'accepts concrete id %s',
    (id) => {
      expect(() => assertValidTenantId(id)).not.toThrow();
    }
  );

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    [' padded', 'leading whitespace'],
    ['padded ', 'trailing whitespace'],
    ['*', 'wildcard star'],
    ['%', 'wildcard percent'],
    ['ten%ant', 'embedded percent'],
    ['ten*ant', 'embedded star'],
    ['line\nbreak', 'newline'],
    ['carriage\rreturn', 'carriage return'],
    ['tab\tcharacter', 'tab'],
    ['nul\u0000character', 'NUL'],
    ['escape\u001bcharacter', 'terminal escape'],
    ['delete\u007fcharacter', 'DEL'],
    ['bidi\u202eoverride', 'Unicode formatting control'],
  ])('rejects %s (%s)', (id) => {
    expect(() => assertValidTenantId(id)).toThrow(InvalidTenantIdError);
  });

  it('rejects non-string input', () => {
    expect(() => assertValidTenantId(undefined)).toThrow(InvalidTenantIdError);
    expect(() => assertValidTenantId(123 as unknown)).toThrow(InvalidTenantIdError);
  });
});

describe('empty tenant deletion manifest', () => {
  it('fails closed when schema discovery produces no entries', async () => {
    vi.resetModules();
    vi.doMock('./schema.postgres', () => ({}));
    try {
      const { buildTenantDeletionManifest } = await import('./tenant-deletion-manifest');
      expect(() => buildTenantDeletionManifest()).toThrow(/manifest is empty/i);
    } finally {
      vi.doUnmock('./schema.postgres');
      vi.resetModules();
    }
  });
});

describe('assertNoRemainingTenantRows', () => {
  it('does nothing when no rows remain', () => {
    expect(() => assertNoRemainingTenantRows([])).not.toThrow();
  });

  it('throws a verification error carrying the offending table names', () => {
    try {
      assertNoRemainingTenantRows(['sessions', 'tasks']);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantDeletionVerificationError);
      expect((error as TenantDeletionVerificationError).tables).toEqual(['sessions', 'tasks']);
    }
  });
});

describe('deleteTenantData guards', () => {
  dbTest('refuses to run against a single-tenant SQLite database', async ({ db }) => {
    await expect(deleteTenantData(db, 'acme-corp')).rejects.toBeInstanceOf(
      TenantDeletionUnsupportedError
    );
  });

  dbTest('refuses to run inside an ambient tenant database scope', async ({ db }) => {
    // runWithTenantDatabaseScope sets the scope store even on SQLite, so the
    // ambient-scope guard fires before the PostgreSQL-only check.
    await expect(
      runWithTenantDatabaseScope(db, 'acme-corp', async () => deleteTenantData(db, 'acme-corp'))
    ).rejects.toThrow(/fresh connection/);
  });
});
