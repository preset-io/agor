import { EXECUTOR_LAUNCH_REFUSED_MESSAGE } from '@agor/core/types';
import { type Task, TaskStatus } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { formatElapsed, turnOutcomeDetails } from './turnOutcomeDetails';

const base = {
  task_id: '01a10b9a-a680-72c0-8c4a-e6f214f8d391',
  session_id: 's',
  created_by: 'u',
  full_prompt: '',
  status: TaskStatus.FAILED,
  created_at: '2026-10-01T00:00:00.000Z',
  git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
} as Task;

describe('turnOutcomeDetails', () => {
  it('shows the shared message and the launch_refused cause for a refused launch', () => {
    const { rows, hasSignal } = turnOutcomeDetails({
      ...base,
      error_message: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
      sdk_failure: {
        reason: 'launch_refused',
        detected_at: '',
        tool: 'claude-code',
        termination: 'verified',
      },
      termination_request: { cause: 'launch_refused', requested_at: '' },
    } as Task);
    expect(hasSignal).toBe(true);
    expect(rows.find((row) => row.label === 'Error')?.value).toBe(EXECUTOR_LAUNCH_REFUSED_MESSAGE);
    expect(rows.find((row) => row.label === 'Cause')?.value).toBe('launch_refused');
  });

  it('lists only the rows that have data, in a fixed order', () => {
    const { rows, hasSignal } = turnOutcomeDetails(
      {
        ...base,
        model: 'gpt-6-astra',
        error_message: 'Codex failed the turn.',
        sdk_failure: {
          reason: 'heartbeat_lost',
          detected_at: '',
          tool: 'codex',
          termination: 'verified',
        },
        termination_request: {
          cause: 'heartbeat_lost',
          requested_at: '',
          requested_by_user_id: 'u-1',
          requested_via: 'mcp',
        },
        latest_executor_pulse: {
          sequence: 3,
          kind: 'progress',
          detail: 'tool_use',
          observed_at: '2026-10-01T00:01:00.000Z',
        },
        started_at: '2026-10-01T00:00:00.000Z',
        completed_at: '2026-10-01T01:02:00.000Z',
        recorded_tool_count: 0,
      } as Task,
      { agenticTool: 'codex', userById: new Map([['u-1', { name: 'Ada Lovelace' } as never]]) }
    );
    expect(hasSignal).toBe(true);
    expect(rows.map((row) => row.label)).toEqual([
      'Error',
      'Cause',
      'Termination',
      'Stopped by',
      'Agent',
      'Last activity',
      'Timing',
      'Tool calls',
      'Task',
    ]);
    expect(rows.find((row) => row.label === 'Cause')?.value).toBe('heartbeat_lost');
    expect(rows.find((row) => row.label === 'Stopped by')?.value).toBe('Ada Lovelace · mcp');
    expect(rows.find((row) => row.label === 'Last activity')?.value).toMatch(
      /^progress: tool_use · /
    );
    expect(rows.find((row) => row.label === 'Timing')?.value).toMatch(/· 1h 02m$/);
    expect(rows.at(-1)).toEqual({ label: 'Task', value: base.task_id, code: true });
  });

  it('treats a plain stop as routine metadata only', () => {
    const { rows, hasSignal } = turnOutcomeDetails({
      ...base,
      status: TaskStatus.STOPPED,
      error_message: 'Stopped by user.',
    });
    expect(hasSignal).toBe(false);
    expect(rows.map((row) => row.label)).toEqual(['Timing', 'Task']);
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(209_000)).toBe('3m 29s');
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
  });
});
