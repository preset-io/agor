import { describe, expect, it } from 'vitest';
import {
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

  it('keeps command-template launcher exits non-authoritative in this passive vitals path', () => {
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: true,
        code: 0,
        localExecutorProcessObserved: false,
      })
    ).toBe(false);
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: true,
        code: 1,
        localExecutorProcessObserved: false,
      })
    ).toBe(false);
  });

  it('keeps local subprocess exits authoritative before terminal state', () => {
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: false,
        code: 0,
        localExecutorProcessObserved: true,
      })
    ).toBe(true);
    expect(
      shouldFailTaskForChildExit({
        usesCommandTemplate: false,
        code: 127,
        localExecutorProcessObserved: false,
      })
    ).toBe(true);
  });
});
