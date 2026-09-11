import { describe, expect, it } from 'vitest';
import type { BranchID, TenantID } from '../types';
import type { WorkerCapacity } from './lifecycle';
import { dependencyCachePath, selectWorkspaceHost, workspaceBlobRoots } from './lifecycle';
import type { WorkspaceState } from './types';

const workers: WorkerCapacity[] = ['one', 'two'].map((host) => ({
  host,
  healthy: true,
  freeBytes: 1000,
  freeInodes: 100,
  freeCpu: 4,
  freeMemoryBytes: 1000,
  freeExecutors: 8,
}));
const demand = { bytes: 100, inodes: 10, cpu: 1, memoryBytes: 100, executors: 2 };
describe('workspace placement and local cache policy', () => {
  it('keeps active affinity, rejects pressure, and permits expired placement recovery', () => {
    const state = { host: 'two', leaseUntil: 2000 } as WorkspaceState;
    expect(selectWorkspaceHost(state, 1000, workers, demand)).toEqual({
      host: 'two',
      reason: 'affinity',
    });
    expect(() => selectWorkspaceHost(state, 1000, [workers[0]], demand)).toThrow('cannot move');
    expect(selectWorkspaceHost(state, 3000, [workers[0]], demand).host).toBe('one');
    expect(() => selectWorkspaceHost(null, 1000, workers, { ...demand, inodes: 200 })).toThrow(
      'No worker'
    );
  });
  it('separates private dependency caches by tenant and complete input identity', () => {
    const scope = { tenantId: 'one' as TenantID, branchId: 'branch' as BranchID };
    const inputs = {
      lockfileHash: 'a',
      manifestsHash: 'b',
      runtime: 'node22',
      packageManager: 'pnpm11',
      platform: 'linux',
      architecture: 'arm64',
      installFlags: 'default',
      registryConfigurationHash: 'c',
    };
    const first = dependencyCachePath('/tmp/cache', scope, inputs);
    expect(
      dependencyCachePath('/tmp/cache', { ...scope, tenantId: 'two' as TenantID }, inputs)
    ).not.toBe(first);
    expect(dependencyCachePath('/tmp/cache', scope, { ...inputs, runtime: 'node24' })).not.toBe(
      first
    );
    expect(() =>
      dependencyCachePath('/tmp/cache', scope, { ...inputs, installFlags: '' })
    ).toThrow();
  });
  it('refuses content GC while a host can still publish', () => {
    expect(() =>
      workspaceBlobRoots([{ host: 'one', leaseUntil: 2000 } as WorkspaceState], 1000)
    ).toThrow('drained');
  });
});
