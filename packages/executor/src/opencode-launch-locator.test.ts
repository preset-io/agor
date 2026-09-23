import { describe, expect, it } from 'vitest';
import { captureOpenCodeCheckpointLaunchLocator } from './opencode-launch-locator.js';

describe('captureOpenCodeCheckpointLaunchLocator', () => {
  it('snapshots only a complete Cloud-owned locator', () => {
    expect(
      captureOpenCodeCheckpointLaunchLocator({
        AGOR_CLOUD_EXECUTOR_RUN_ID: 'run-1',
        AGOR_CLOUD_EXECUTOR_CELL_ID: 'cell-1',
        AGOR_CLOUD_EXECUTOR_NAMESPACE: 'tenant-ns',
        AGOR_CLOUD_EXECUTOR_POD_NAME: 'executor-1',
        AGOR_CLOUD_EXECUTOR_POD_UID: 'pod-uid-1',
        AGOR_CLOUD_EXECUTOR_CONTAINER_NAME: 'executor',
      })
    ).toEqual({
      runId: 'run-1',
      cellId: 'cell-1',
      namespace: 'tenant-ns',
      podName: 'executor-1',
      podUid: 'pod-uid-1',
      containerName: 'executor',
    });
  });

  it('refuses missing, malformed, or another container identity', () => {
    expect(
      captureOpenCodeCheckpointLaunchLocator({ AGOR_CLOUD_EXECUTOR_RUN_ID: 'run-1' })
    ).toBeNull();
    expect(
      captureOpenCodeCheckpointLaunchLocator({
        AGOR_CLOUD_EXECUTOR_RUN_ID: 'run-1',
        AGOR_CLOUD_CELL_ID: 'cell-1',
        AGOR_CLOUD_EXECUTOR_NAMESPACE: 'tenant-ns',
        AGOR_CLOUD_EXECUTOR_POD_NAME: 'executor-1',
        AGOR_CLOUD_EXECUTOR_POD_UID: 'pod-uid-1',
        AGOR_CLOUD_EXECUTOR_CONTAINER_NAME: 'executor',
      })
    ).toBeNull();
    expect(
      captureOpenCodeCheckpointLaunchLocator({
        AGOR_CLOUD_EXECUTOR_RUN_ID: 'run-1',
        AGOR_CLOUD_EXECUTOR_CELL_ID: 'cell-1',
        AGOR_CLOUD_EXECUTOR_NAMESPACE: 'tenant-ns',
        AGOR_CLOUD_EXECUTOR_POD_NAME: 'executor-1',
        AGOR_CLOUD_EXECUTOR_POD_UID: 'pod-uid-1',
        AGOR_CLOUD_EXECUTOR_CONTAINER_NAME: 'payload',
      })
    ).toBeNull();
  });
});
