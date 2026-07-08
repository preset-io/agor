import { describe, expect, it } from 'vitest';
import {
  hasObservedLaunchedExecutorProcess,
  isExecutorSpawnFailureExit,
  shouldFailCommandTemplateLauncherExit,
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

  it('does not fail command-template tasks for successful launcher exits', () => {
    expect(
      shouldFailCommandTemplateLauncherExit({
        code: 0,
        connected: false,
        activeTask: true,
        isLatestTask: true,
        sessionExecuting: true,
      })
    ).toBe(false);
  });

  it('fails command-template tasks for non-zero launcher exits before executor_connected', () => {
    expect(
      shouldFailCommandTemplateLauncherExit({
        code: 1,
        connected: false,
        activeTask: true,
        isLatestTask: true,
        sessionExecuting: true,
      })
    ).toBe(true);
  });

  it('does not fail command-template tasks for launcher exits after executor_connected', () => {
    expect(
      shouldFailCommandTemplateLauncherExit({
        code: 1,
        connected: true,
        activeTask: true,
        isLatestTask: true,
        sessionExecuting: true,
      })
    ).toBe(false);
  });
});
