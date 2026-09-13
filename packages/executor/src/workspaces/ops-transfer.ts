import type { WorkspaceScope, WorkspaceState } from '@agor/core/workspaces/types';
/** Compare-and-claim inside the metadata transaction; never overwrite a newer owner. */
export function claimTransfer(
  state: WorkspaceState | null,
  now: number,
  expected: {
    scope: WorkspaceScope;
    epoch: number;
    recovery: string;
    host: string;
    leaseMs: number;
  }
): WorkspaceState {
  if (
    !state ||
    state.scope.tenantId !== expected.scope.tenantId ||
    state.scope.branchId !== expected.scope.branchId ||
    state.epoch !== expected.epoch ||
    state.host ||
    state.localRecovery?.hash !== expected.recovery ||
    Object.keys(state.active).length ||
    Object.values(state.receipts).some((r) => r.outcome.status === 'conflict')
  )
    throw new Error('Branch changed since export; transfer refused');
  state.epoch++;
  state.host = expected.host;
  state.leaseUntil = now + expected.leaseMs;
  return state;
}
