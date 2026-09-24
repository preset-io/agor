import { OPENCODE_OBSERVER_BUSY_REASON } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  parseResolvedLocator,
  selectManagedOpenCodeAdmissionStoreId,
  withOpenCodeObserverSlot,
} from './opencode-native-state';

describe('managed OpenCode admission retry store binding', () => {
  it('reuses a committed attempt store after a lost response instead of generating a new one', () => {
    expect(selectManagedOpenCodeAdmissionStoreId('admitted-store', undefined, undefined)).toBe(
      'admitted-store'
    );
    expect(
      selectManagedOpenCodeAdmissionStoreId('admitted-store', 'stale-session', 'stale-pointer')
    ).toBe('admitted-store');
    expect(selectManagedOpenCodeAdmissionStoreId(undefined, 'session-store', undefined)).toBe(
      'session-store'
    );
  });
});

function resolvedLocator(containerId: string) {
  return {
    runId: 'run-1',
    cellId: 'cell-1',
    tenantId: 'tenant-1',
    ownerRuntimeUserId: 'user-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    storeId: 'store-1',
    holderInstanceId: 'holder-1',
    namespace: 'tenant-ns',
    jobName: 'executor-job',
    jobUid: 'job-uid',
    podName: 'executor-pod',
    podUid: 'pod-uid',
    containerName: 'executor',
    containerId,
    restartCount: 0,
    imageIdentity: `sha256:${'a'.repeat(64)}`,
  };
}

describe('parseResolvedLocator', () => {
  it('accepts the exact CRI container ID returned by Cloud', () => {
    expect(parseResolvedLocator(resolvedLocator('containerd://0123456789abcdef'))).toMatchObject({
      containerId: 'containerd://0123456789abcdef',
    });
  });

  it('rejects a malformed container ID instead of widening other Cloud identifiers', () => {
    expect(() => parseResolvedLocator(resolvedLocator('../containerd://id'))).toThrow(
      /invalid container binding/
    );
  });
});

describe('trusted Cloud observer helper budget', () => {
  it('allows only one helper per tenant task and throttles immediate replay', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const first = withOpenCodeObserverSlot(
        'tenant-budget',
        'task-budget',
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => {})
      ).rejects.toMatchObject({
        code: 429,
        data: { reason: OPENCODE_OBSERVER_BUSY_REASON },
      });
      finish();
      await first;
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => {})
      ).rejects.toThrow(/busy/);
      vi.advanceTimersByTime(1_000);
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => 'admitted')
      ).resolves.toBe('admitted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one tenant from occupying every helper slot', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 4 }, (_, index) =>
      withOpenCodeObserverSlot(
        'tenant-a-budget',
        `task-${index}`,
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-a-budget', 'task-fifth', 'resolve', async () => {})
    ).rejects.toThrow(/busy/);
    await expect(
      withOpenCodeObserverSlot('tenant-b-budget', 'task-first', 'resolve', async () => 'admitted')
    ).resolves.toBe('admitted');
    for (const release of releases) release();
    await Promise.all(pending);
  });

  it('reserves capacity for admission when observations are busy', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 4 }, (_, index) =>
      withOpenCodeObserverSlot(
        `tenant-observe-${index}`,
        `task-${index}`,
        'observe',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-observe-fifth', 'task-fifth', 'observe', async () => {})
    ).rejects.toThrow(/busy/);
    await expect(
      withOpenCodeObserverSlot('tenant-resolve', 'task-first', 'resolve', async () => 'admitted')
    ).resolves.toBe('admitted');
    for (const release of releases) release();
    await Promise.all(pending);
  });

  it('caps total helpers across many tenants', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 16 }, (_, index) =>
      withOpenCodeObserverSlot(
        `tenant-global-${Math.floor(index / 4)}`,
        `task-${index}`,
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-global-fifth', 'task-extra', 'resolve', async () => {})
    ).rejects.toThrow(/busy/);
    for (const release of releases) release();
    await Promise.all(pending);
  });
});
