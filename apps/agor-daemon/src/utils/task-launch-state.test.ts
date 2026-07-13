import { TaskStatus } from '@agor/core/types';
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
    expect(buildTaskLaunchState(tool, '2026-07-10T20:00:00.000Z')).toEqual({
      status: TaskStatus.DISPATCHING,
      started_at: '2026-07-10T20:00:00.000Z',
    });
  });
});
