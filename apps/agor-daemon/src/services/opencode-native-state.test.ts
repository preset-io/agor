import { describe, expect, it } from 'vitest';
import { parseResolvedLocator } from './opencode-native-state';

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
