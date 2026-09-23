import {
  isOpenCodeCheckpointLaunchLocator,
  OPENCODE_CHECKPOINT_CLOUD_ENV,
  type OpenCodeCheckpointLaunchLocator,
} from '@agor/core/types';

export type { OpenCodeCheckpointLaunchLocator } from '@agor/core/types';

/** Snapshot only launch-owned Cloud coordinates before any payload env is applied. */
export function captureOpenCodeCheckpointLaunchLocator(
  environment: NodeJS.ProcessEnv = process.env
): OpenCodeCheckpointLaunchLocator | null {
  const keys = OPENCODE_CHECKPOINT_CLOUD_ENV;
  const candidate = {
    runId: environment[keys.runId],
    cellId: environment[keys.cellId],
    namespace: environment[keys.namespace],
    podName: environment[keys.podName],
    podUid: environment[keys.podUid],
    containerName: environment[keys.containerName],
  };
  return isOpenCodeCheckpointLaunchLocator(candidate) ? Object.freeze(candidate) : null;
}
