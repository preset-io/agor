import type { Database } from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import {
  beginManagedCellRetirement,
  executeManagedRetirement,
  listManagedRetirementTargets,
  validateManagedCellRetirementRequest,
  validateManagedRetirementRequest,
  validateManagedRetirementTargets,
} from './managed-oauth-retirement';

const gate = '01a0a542-7d55-73be-ac07-495b2b0cc0a8';
const input = { tenant_id: 'tenant-a', operation_id: 'operation-a', gate_generation: gate };
const cell = { cell_id: 'cell-a', operation_id: 'decommission-a' };
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error('DATABASE_TOUCHED');
    },
  }
) as Database;

describe('managed lifecycle CLI request boundary', () => {
  it('accepts bounded IDs and canonical gate proof without opening a database', () => {
    expect(() => validateManagedRetirementRequest(input)).not.toThrow();
    expect(() => validateManagedCellRetirementRequest(cell, 'cell-a')).not.toThrow();
    expect(() =>
      validateManagedRetirementTargets(undefined, 100, { ...cell, gate_generation: gate }, 'cell-a')
    ).not.toThrow();
  });
  it.each([
    { ...input, tenant_id: '' },
    { ...input, tenant_id: 'a'.repeat(1025) },
    { ...input, tenant_id: 'tenant\0b' },
    { ...input, gate_generation: 'not-a-generation' },
    { ...input, operation_id: '../foreign' },
    { ...input, operation_id: 'x'.repeat(129) },
  ])('rejects invalid tenant request before any database access: %j', async (value) => {
    await expect(executeManagedRetirement(noDatabase, value, true)).rejects.not.toThrow(
      'DATABASE_TOUCHED'
    );
    expect(() => validateManagedRetirementRequest(value)).toThrow();
  });
  it.each([undefined, '', 'cell-b'])(
    'refuses absent or foreign configured cell %s',
    async (configured) => {
      await expect(beginManagedCellRetirement(noDatabase, cell, configured)).rejects.not.toThrow(
        'DATABASE_TOUCHED'
      );
      expect(() => validateManagedCellRetirementRequest(cell, configured)).toThrow();
    }
  );
  it.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects page limit %s before DB',
    async (limit) => {
      await expect(listManagedRetirementTargets(noDatabase, undefined, limit)).rejects.not.toThrow(
        'DATABASE_TOUCHED'
      );
      expect(() => validateManagedRetirementTargets(undefined, limit)).toThrow();
    }
  );
  it('does not accept a requested cell as deployment identity or a malformed cell fence', async () => {
    await expect(
      listManagedRetirementTargets(
        noDatabase,
        undefined,
        100,
        { ...cell, gate_generation: gate },
        'cell-b'
      )
    ).rejects.not.toThrow('DATABASE_TOUCHED');
    expect(() =>
      validateManagedRetirementTargets(
        undefined,
        100,
        { ...cell, gate_generation: 'changed' },
        'cell-a'
      )
    ).toThrow();
  });
});
