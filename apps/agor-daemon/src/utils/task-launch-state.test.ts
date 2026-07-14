import { EXECUTOR_STATE_PERSISTENCE_REQUIREMENT, TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildTaskLaunchState } from './task-launch-state.js';

describe('buildTaskLaunchState', () => {
  it('launches claude-code-cli directly into running without a connection timestamp', () => {
    const launchState = buildTaskLaunchState('claude-code-cli', '2026-07-10T20:00:00.000Z');

    expect(launchState).toEqual({
      status: TaskStatus.RUNNING,
      started_at: '2026-07-10T20:00:00.000Z',
    });
    expect(launchState).not.toHaveProperty('executor_connected_at');
  });

  it.each([
    'claude-code',
    'codex',
    'gemini',
    'opencode',
    'copilot',
    'cursor',
  ] as const)('launches %s through the executor dispatch state', (tool) => {
    expect(buildTaskLaunchState(tool, '2026-07-10T20:00:00.000Z')).toEqual(
      expect.objectContaining({
        status: TaskStatus.DISPATCHING,
        started_at: '2026-07-10T20:00:00.000Z',
        executor_attempt_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      })
    );
  });

  it('captures the state-persistence requirement before launch', () => {
    const launchState = buildTaskLaunchState('codex', '2026-07-10T20:00:00.000Z', true);

    expect(launchState.executor_finalization?.state_persistence_requirement).toBe(
      EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.REQUIRED
    );
  });
});
