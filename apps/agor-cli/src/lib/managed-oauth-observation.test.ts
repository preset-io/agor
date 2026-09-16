import type { Database } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import {
  observeManagedOAuthDatabase,
  validateManagedObservationCell,
} from './managed-oauth-observation';

const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error('DATABASE_TOUCHED');
    },
  }
) as Database;

describe('managed database observation operator boundary', () => {
  it('accepts the exact configured cell', () => {
    expect(() => validateManagedObservationCell('cell-a', 'cell-a')).not.toThrow();
  });
  it.each([undefined, '', 'cell-b'])(
    'rejects absent/foreign configuration %s before DB access',
    async (configured) => {
      await expect(observeManagedOAuthDatabase(noDatabase, 'cell-a', configured)).rejects.toThrow(
        'configured cell'
      );
    }
  );
  it.each(['', '../cell', 'a'.repeat(129), 'cell\u0000a'])(
    'rejects malformed identity %s even if configured',
    async (cell) => {
      await expect(observeManagedOAuthDatabase(noDatabase, cell, cell)).rejects.toThrow(
        'configured cell'
      );
    }
  );
});
