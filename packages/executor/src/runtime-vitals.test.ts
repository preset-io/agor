import { TaskRuntimeEventKind, TaskRuntimePhase, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRuntimeVitalsReporter, wrapTasksServiceWithRuntimeVitals } from './runtime-vitals.js';

function createClient(patches: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    service(name: string) {
      if (name !== 'tasks') throw new Error(`unexpected service ${name}`);
      return {
        patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
          patches.push({ id, data });
          return { task_id: id, ...data };
        }),
      };
    },
  } as never;
}

describe('TaskRuntimeVitalsReporter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores compact capped events and throttles non-forced writes', async () => {
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient(patches),
      taskId: 'task-1',
      toolName: 'codex',
      maxEvents: 3,
      minPatchIntervalMs: 5_000,
      now: () => new Date(nowMs),
    });

    await reporter.record(TaskRuntimeEventKind.SDK_TURN_STARTED, {
      phase: TaskRuntimePhase.SDK_STARTING,
      source: 'executor',
      forceFlush: true,
    });
    nowMs += 1_000;
    await reporter.record(TaskRuntimeEventKind.THINKING, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'sdk',
      meaningful: true,
    });
    await reporter.record(TaskRuntimeEventKind.TOOL_START, {
      phase: TaskRuntimePhase.TOOL_RUNNING,
      source: 'tool',
      meaningful: true,
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });
    await reporter.record(TaskRuntimeEventKind.TOOL_PROGRESS, {
      phase: TaskRuntimePhase.TOOL_RUNNING,
      source: 'tool',
      meaningful: true,
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });

    expect(patches).toHaveLength(3);
    expect(patches[0]?.data).toEqual({ runtime_vitals: expect.any(Object) });
    expect(patches[0]?.data).not.toHaveProperty('status');

    nowMs += 5_000;
    await reporter.record(TaskRuntimeEventKind.TOOL_COMPLETE, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'tool',
      meaningful: true,
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });

    expect(patches).toHaveLength(4);
    const vitals = patches[3]?.data.runtime_vitals as NonNullable<typeof reporter.snapshot>;
    expect(vitals.recent_events).toHaveLength(3);
    expect(vitals.recent_events?.map((event) => event.kind)).toEqual([
      TaskRuntimeEventKind.TOOL_START,
      TaskRuntimeEventKind.TOOL_PROGRESS,
      TaskRuntimeEventKind.TOOL_COMPLETE,
    ]);
    expect(vitals.last_meaningful_progress_at).toBeDefined();
    expect(vitals.counters?.meaningful_progress_events).toBe(4);
    expect(vitals.active_tool).toBeNull();
    expect(JSON.stringify(vitals)).not.toContain('secret');
  });

  it('flushes first meaningful progress immediately inside the throttle window', async () => {
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient(patches),
      taskId: 'task-1',
      toolName: 'codex',
      minPatchIntervalMs: 5_000,
      now: () => new Date(nowMs),
    });

    await reporter.record(TaskRuntimeEventKind.TASK_STATUS, {
      phase: TaskRuntimePhase.AWAITING_FIRST_AGENT_EVENT,
      source: 'executor',
      forceFlush: true,
    });
    nowMs += 1_000;

    await reporter.record(TaskRuntimeEventKind.THINKING, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'sdk',
      meaningful: true,
    });

    expect(patches).toHaveLength(2);
    const vitals = patches[1]?.data.runtime_vitals as NonNullable<typeof reporter.snapshot>;
    expect(vitals.phase).toBe(TaskRuntimePhase.RUNNING);
    expect(vitals.first_meaningful_progress_at).toBe('2026-01-01T00:00:01.000Z');
    expect(vitals.last_event?.kind).toBe(TaskRuntimeEventKind.THINKING);
  });

  it('schedules a trailing flush for throttled updates', async () => {
    vi.useFakeTimers();
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient(patches),
      taskId: 'task-1',
      toolName: 'codex',
      minPatchIntervalMs: 5_000,
      now: () => new Date(nowMs),
    });

    await reporter.record(TaskRuntimeEventKind.SDK_TURN_STARTED, {
      phase: TaskRuntimePhase.SDK_STARTING,
      source: 'executor',
      forceFlush: true,
    });
    nowMs += 1_000;
    await reporter.record(TaskRuntimeEventKind.THINKING, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'sdk',
      meaningful: true,
    });

    nowMs += 1_000;
    await reporter.record(TaskRuntimeEventKind.THINKING, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'sdk',
      meaningful: true,
    });

    expect(patches).toHaveLength(2);

    nowMs += 3_999;
    await vi.advanceTimersByTimeAsync(3_999);
    expect(patches).toHaveLength(2);

    nowMs += 1;
    await vi.advanceTimersByTimeAsync(1);

    expect(patches).toHaveLength(3);
    const vitals = patches[2]?.data.runtime_vitals as NonNullable<typeof reporter.snapshot>;
    expect(vitals.last_activity_at).toBe('2026-01-01T00:00:02.000Z');
    expect(vitals.last_event?.kind).toBe(TaskRuntimeEventKind.THINKING);
    expect(vitals.counters?.meaningful_progress_events).toBe(2);
  });

  it('writes explicit active_tool null after tool completion and terminal snapshots', async () => {
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient(patches),
      taskId: 'task-1',
      toolName: 'claude-code',
      minPatchIntervalMs: 0,
      now: () => new Date(nowMs),
    });

    await reporter.record(TaskRuntimeEventKind.TOOL_START, {
      phase: TaskRuntimePhase.TOOL_RUNNING,
      source: 'tool',
      meaningful: true,
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });
    nowMs += 1_000;
    await reporter.record(TaskRuntimeEventKind.TOOL_COMPLETE, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'tool',
      meaningful: true,
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });

    expect(
      (patches[1]?.data.runtime_vitals as NonNullable<typeof reporter.snapshot>).active_tool
    ).toBeNull();

    const terminalVitals = await reporter.terminalSnapshot(TaskRuntimeEventKind.TURN_COMPLETED, {
      phase: TaskRuntimePhase.COMPLETED,
      source: 'sdk',
    });

    expect(terminalVitals.active_tool).toBeNull();
  });

  it('builds terminal vitals without issuing terminal side-effect patches', async () => {
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient(patches),
      taskId: 'task-1',
      toolName: 'claude-code',
      minPatchIntervalMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await reporter.record(TaskRuntimeEventKind.SDK_TURN_STARTED, {
      phase: TaskRuntimePhase.SDK_STARTING,
      forceFlush: true,
    });

    const terminalVitals = await reporter.terminalSnapshot(TaskRuntimeEventKind.TURN_COMPLETED, {
      phase: TaskRuntimePhase.COMPLETED,
      source: 'sdk',
    });
    await reporter.record(TaskRuntimeEventKind.THINKING, {
      phase: TaskRuntimePhase.RUNNING,
      source: 'sdk',
      meaningful: true,
      forceFlush: true,
    });

    expect(terminalVitals.phase).toBe(TaskRuntimePhase.COMPLETED);
    expect(terminalVitals.last_event?.kind).toBe(TaskRuntimeEventKind.TURN_COMPLETED);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.data).toEqual({ runtime_vitals: expect.any(Object) });
    expect(patches[0]?.data).not.toHaveProperty('status');
  });
});

describe('wrapTasksServiceWithRuntimeVitals', () => {
  it('observes status patches but only adds runtime_vitals after caller-owned terminal patches', async () => {
    const calls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const rawTasksService = {
      get: vi.fn(),
      emit: vi.fn(),
      patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
        calls.push({ id, data });
        return { task_id: id, ...data };
      }),
    };
    const reporter = new TaskRuntimeVitalsReporter({
      client: createClient([]),
      taskId: 'task-1',
      toolName: 'claude-code',
      minPatchIntervalMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const wrapped = wrapTasksServiceWithRuntimeVitals(rawTasksService, reporter);

    await wrapped.patch('task-1', { status: TaskStatus.AWAITING_PERMISSION });
    await wrapped.patch('task-1', { status: TaskStatus.RUNNING });
    await wrapped.patch('task-1', { status: TaskStatus.FAILED });

    expect(calls).toEqual([
      { id: 'task-1', data: { status: TaskStatus.AWAITING_PERMISSION } },
      { id: 'task-1', data: { status: TaskStatus.RUNNING } },
      { id: 'task-1', data: { status: TaskStatus.FAILED } },
      { id: 'task-1', data: { runtime_vitals: expect.any(Object) } },
    ]);
    expect(calls[3]?.data).not.toHaveProperty('status');
  });
});
