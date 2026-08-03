import { describe, expect, it } from 'vitest';
import {
  deriveTaskRuntimeProgressState,
  ExecutorPulseKind,
  ExecutorSettlementInputSchema,
  isTaskExecuting,
  isTaskPendingDispatch,
  NONTERMINAL_TASK_STATUSES,
  TaskStatus,
  TERMINAL_TASK_STATUSES,
} from './task';

describe('ExecutorSettlementInputSchema', () => {
  const quiesced = {
    task_id: 'task-1',
    kind: 'quiesced',
    status: TaskStatus.COMPLETED,
    task_patch: {
      git_state: { sha_at_end: 'abc123' },
      model: 'test-model',
      normalized_sdk_response: {
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        contextUsageSnapshot: { totalTokens: 3, maxTokens: 100, percentage: 3 },
      },
      report: {
        path: 'session/task.md',
        template: 'standard',
        generated_at: '2026-01-01T00:00:00.000Z',
      },
    },
  } as const;

  it('accepts both executor settlement variants', () => {
    expect(ExecutorSettlementInputSchema.parse(quiesced)).toEqual(quiesced);
    expect(
      ExecutorSettlementInputSchema.parse({
        task_id: 'task-1',
        kind: 'containment_required',
        error_message: 'cleanup was not verified',
      })
    ).toMatchObject({ kind: 'containment_required' });
  });

  it.each([
    { ...quiesced, status: TaskStatus.RUNNING },
    { ...quiesced, unexpected: true },
    { ...quiesced, task_patch: { unexpected: true } },
    { ...quiesced, task_patch: { git_state: { sha_at_end: 'abc123', unexpected: true } } },
    {
      ...quiesced,
      task_patch: {
        normalized_sdk_response: {
          tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, unexpected: true },
        },
      },
    },
  ])('rejects malformed or unknown settlement data %#', (input) => {
    expect(ExecutorSettlementInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('task execution helpers', () => {
  it('identifies only states that still need a daemon dispatch claim', () => {
    expect(isTaskPendingDispatch({ status: TaskStatus.CREATED })).toBe(true);
    expect(isTaskPendingDispatch({ status: TaskStatus.QUEUED })).toBe(true);
    expect(isTaskPendingDispatch({ status: TaskStatus.DISPATCHING })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.RUNNING })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskPendingDispatch({ status: TaskStatus.FAILED })).toBe(false);
  });

  it('keeps terminal and nonterminal status collections exhaustive and disjoint', () => {
    expect(
      [...NONTERMINAL_TASK_STATUSES].filter((status) => TERMINAL_TASK_STATUSES.has(status))
    ).toEqual([]);
    expect([...NONTERMINAL_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort()).toEqual(
      Object.values(TaskStatus).sort()
    );
  });

  it('identifies executor-owned task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.DISPATCHING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.RUNNING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.STOPPING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_PERMISSION })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_INPUT })).toBe(true);
  });

  it('excludes queued, pre-dispatch, and terminal task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.QUEUED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.CREATED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.FAILED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.STOPPED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.TIMED_OUT })).toBe(false);
  });
});

describe('deriveTaskRuntimeProgressState', () => {
  const progress = {
    sequence: 2,
    kind: ExecutorPulseKind.PROGRESS,
    detail: 'assistant',
    observed_at: '2026-01-01T00:00:02.000Z',
  } as const;

  it('does not infer meaningful work from RUNNING alone', () => {
    expect(deriveTaskRuntimeProgressState({ status: TaskStatus.RUNNING })).toBe('inactive');
  });

  it('distinguishes working, waiting, and terminal presentation', () => {
    expect(
      deriveTaskRuntimeProgressState({
        status: TaskStatus.RUNNING,
        latest_executor_pulse: progress,
      })
    ).toBe('working');
    expect(
      deriveTaskRuntimeProgressState({
        status: TaskStatus.RUNNING,
        latest_executor_pulse: {
          sequence: 3,
          kind: ExecutorPulseKind.WAITING,
          detail: 'permission',
          observed_at: '2026-01-01T00:00:03.000Z',
        },
      })
    ).toBe('waiting');
    expect(deriveTaskRuntimeProgressState({ status: TaskStatus.COMPLETED })).toBe('terminal');
  });

  it('does not present containment as continued agent progress', () => {
    expect(
      deriveTaskRuntimeProgressState({
        status: TaskStatus.STOPPING,
        latest_executor_pulse: progress,
      })
    ).toBe('inactive');
  });

  it('shows a stall until later meaningful progress supersedes an observe diagnosis', () => {
    const task = {
      status: TaskStatus.RUNNING,
      latest_executor_progress: progress,
      sdk_failure: {
        reason: 'progress_stalled' as const,
        detected_at: '2026-01-01T00:00:01.000Z',
        tool: 'codex' as const,
        pulse_sequence_at_detection: 1,
        watchdog_action: 'would_fire' as const,
        termination: 'not_requested' as const,
      },
    };
    expect(deriveTaskRuntimeProgressState(task)).toBe('working');
    expect(
      deriveTaskRuntimeProgressState({
        ...task,
        latest_executor_progress: { ...progress, sequence: 1 },
      })
    ).toBe('stalled');
  });
});
