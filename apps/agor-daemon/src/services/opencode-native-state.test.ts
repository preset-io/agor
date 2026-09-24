import { describe, expect, it, vi } from 'vitest';
import { parseResolvedLocator, withOpenCodeObserverSlot } from './opencode-native-state';

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
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', async () => {})
      ).rejects.toThrow(/busy/);
      finish();
      await first;
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', async () => {})
      ).rejects.toThrow(/busy/);
      vi.advanceTimersByTime(1_000);
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', async () => 'admitted')
      ).resolves.toBe('admitted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps concurrent helpers across different tasks on the shared daemon', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 8 }, (_, index) =>
      withOpenCodeObserverSlot(
        'tenant-global-budget',
        `task-${index}`,
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-global-budget', 'task-ninth', async () => {})
    ).rejects.toThrow(/busy/);
    for (const release of releases) release();
    await Promise.all(pending);
  });
});
