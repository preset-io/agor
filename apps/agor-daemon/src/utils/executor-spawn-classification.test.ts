import { TaskRuntimeEventKind, TaskRuntimePhase } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  hasExecutorRuntimeEvidence,
  hasObservedLaunchedExecutorProcess,
  isExecutorSpawnFailureExit,
  shouldFailTaskForChildExit,
} from './executor-spawn-classification.js';

describe('executor spawn classification', () => {
  it('does not treat a ChildProcess without a pid as an observed launch', () => {
    expect(hasObservedLaunchedExecutorProcess({ pid: undefined })).toBe(false);
  });

  it('treats a positive ChildProcess pid as an observed launch', () => {
    expect(hasObservedLaunchedExecutorProcess({ pid: 12345 })).toBe(true);
  });

  it('preserves spawn failure classification for spawn-error exits', () => {
    expect(isExecutorSpawnFailureExit(false, 127)).toBe(true);
  });

  it('keeps real child exits classified as process exits', () => {
    expect(isExecutorSpawnFailureExit(true, 127)).toBe(false);
  });

  it('does not classify successful exits as spawn failures', () => {
    expect(isExecutorSpawnFailureExit(false, 0)).toBe(false);
  });

  it('detects executor runtime evidence from non-daemon vitals events', () => {
    expect(hasExecutorRuntimeEvidence(undefined)).toBe(false);
    expect(
      hasExecutorRuntimeEvidence({
        schema_version: 1,
        phase: TaskRuntimePhase.EXECUTOR_STARTING,
        phase_started_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: '2026-01-01T00:00:00.000Z',
        last_event: {
          kind: TaskRuntimeEventKind.EXECUTOR_SPAWN_REQUESTED,
          at: '2026-01-01T00:00:00.000Z',
          source: 'daemon',
        },
      })
    ).toBe(false);
    expect(
      hasExecutorRuntimeEvidence({
        schema_version: 1,
        phase: TaskRuntimePhase.SDK_STARTING,
        phase_started_at: '2026-01-01T00:00:01.000Z',
        last_activity_at: '2026-01-01T00:00:01.000Z',
        last_event: {
          kind: TaskRuntimeEventKind.SDK_TURN_STARTED,
          at: '2026-01-01T00:00:01.000Z',
          source: 'executor',
        },
      })
    ).toBe(true);
  });

  it('keeps command-template launcher exits non-authoritative after successful submission or executor evidence', () => {
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: true,
        code: 0,
        localExecutorProcessObserved: false,
        executorRuntimeObserved: false,
      })
    ).toBe(false);
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: true,
        code: 1,
        localExecutorProcessObserved: false,
        executorRuntimeObserved: false,
      })
    ).toBe(true);
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: true,
        code: 1,
        localExecutorProcessObserved: false,
        executorRuntimeObserved: true,
      })
    ).toBe(false);
  });

  it('keeps local subprocess exits authoritative before terminal state', () => {
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: false,
        code: 0,
        localExecutorProcessObserved: true,
        executorRuntimeObserved: false,
      })
    ).toBe(true);
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: false,
        code: 127,
        localExecutorProcessObserved: false,
        executorRuntimeObserved: false,
      })
    ).toBe(true);
  });
});
