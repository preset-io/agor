import type { WorkspaceState } from '@agor/core/workspaces/types';
import { expect, it } from 'vitest';
import { claimTransfer } from './ops-transfer.js';

const make = () =>
  ({
    schema: 1,
    scope: { tenantId: 'tenant-a', branchId: 'branch-a' },
    epoch: 7,
    revision: 2,
    host: null,
    leaseUntil: 0,
    tree: {},
    versions: {},
    active: {},
    receipts: {},
    updatedAt: 0,
    localRecovery: { hash: 'snapshot', revision: 2, origin: 'source', createdAt: 0, epoch: 6 },
  }) as WorkspaceState;
const expected = () => ({
  scope: make().scope,
  epoch: 7,
  recovery: 'snapshot',
  host: 'target',
  leaseMs: 60000,
});
it('claims only the exported generation once', () => {
  const state = claimTransfer(make(), 100, expected());
  expect(state.host).toBe('target');
  expect(state.epoch).toBe(8);
  expect(state.leaseUntil).toBe(60100);
  expect(() => claimTransfer(state, 200, expected())).toThrow('Branch changed');
});
it('rejects foreign tenant/branch, newer generations, a new owner and another snapshot', () => {
  for (const field of ['tenantId', 'branchId'] as const) {
    const input = expected();
    input.scope = { ...input.scope, [field]: 'foreign' };
    expect(() => claimTransfer(make(), 100, input)).toThrow('Branch changed');
  }
  for (const change of [
    { epoch: 8 },
    { host: 'other' },
    { localRecovery: { ...make().localRecovery!, hash: 'other' } },
  ])
    expect(() => claimTransfer({ ...make(), ...change }, 100, expected())).toThrow(
      'Branch changed'
    );
});
