import {
  type Task,
  TaskRuntimeEventKind,
  TaskRuntimePhase,
  type TaskRuntimeVitals,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDaemonTaskRuntimeVitals,
  patchDaemonTaskRuntimeEvent,
} from './task-runtime-vitals.js';

describe('daemon task runtime vitals', () => {
  it('records compact spawn lifecycle events with sanitized process facts', () => {
    const requested = buildDaemonTaskRuntimeVitals(
      undefined,
      TaskRuntimeEventKind.EXECUTOR_SPAWN_REQUESTED,
      {
        at: '2026-01-01T00:00:00.000Z',
        phase: TaskRuntimePhase.EXECUTOR_STARTING,
      }
    );

    const spawned = buildDaemonTaskRuntimeVitals(
      requested,
      TaskRuntimeEventKind.EXECUTOR_PROCESS_SPAWNED,
      {
        at: '2026-01-01T00:00:01.000Z',
        phase: TaskRuntimePhase.EXECUTOR_STARTING,
        processPid: 12345,
        errorCode: 'Raw message with spaces and SECRET=hidden',
      }
    );

    expect(spawned.phase).toBe(TaskRuntimePhase.EXECUTOR_STARTING);
    expect(spawned.counters?.events).toBe(2);
    expect(spawned.recent_events?.map((event) => event.kind)).toEqual([
      TaskRuntimeEventKind.EXECUTOR_SPAWN_REQUESTED,
      TaskRuntimeEventKind.EXECUTOR_PROCESS_SPAWNED,
    ]);
    expect(spawned.last_event).toMatchObject({
      kind: TaskRuntimeEventKind.EXECUTOR_PROCESS_SPAWNED,
      source: 'daemon',
      process_pid: 12345,
      error_code: 'unknown',
    });
    expect(JSON.stringify(spawned)).not.toContain('SECRET');
  });

  it('records spawn failure as a terminal failed snapshot and clears active_tool explicitly', () => {
    const previous: TaskRuntimeVitals = {
      schema_version: 1,
      phase: TaskRuntimePhase.TOOL_RUNNING,
      phase_started_at: '2026-01-01T00:00:00.000Z',
      last_activity_at: '2026-01-01T00:00:00.000Z',
      active_tool: {
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        started_at: '2026-01-01T00:00:00.000Z',
      },
      counters: { events: 3, meaningful_progress_events: 1 },
      recent_events: [],
    };

    const failed = buildDaemonTaskRuntimeVitals(
      previous,
      TaskRuntimeEventKind.EXECUTOR_SPAWN_FAILED,
      {
        at: '2026-01-01T00:00:02.000Z',
        phase: TaskRuntimePhase.FAILED,
        errorCode: 'spawn_exception',
      }
    );

    expect(failed.phase).toBe(TaskRuntimePhase.FAILED);
    expect(failed.active_tool).toBeNull();
    expect(failed.counters).toMatchObject({
      events: 4,
      meaningful_progress_events: 1,
    });
    expect(failed.last_event).toMatchObject({
      kind: TaskRuntimeEventKind.EXECUTOR_SPAWN_FAILED,
      error_code: 'spawn_exception',
    });
  });

  it('patches through the task update path using the current persisted snapshot', async () => {
    const patches: Array<{ id: string; data: Partial<Task> }> = [];
    const task: Partial<Task> = {
      task_id: 'task-1' as never,
      status: TaskStatus.RUNNING,
      runtime_vitals: buildDaemonTaskRuntimeVitals(
        undefined,
        TaskRuntimeEventKind.EXECUTOR_SPAWN_REQUESTED,
        {
          at: '2026-01-01T00:00:00.000Z',
          phase: TaskRuntimePhase.EXECUTOR_STARTING,
        }
      ),
    };
    const service = {
      get: vi.fn(async () => task as Task),
      patch: vi.fn(async (id: string, data: Partial<Task>) => {
        patches.push({ id, data });
        task.runtime_vitals = data.runtime_vitals;
        return { ...task, ...data } as Task;
      }),
    };

    const vitals = await patchDaemonTaskRuntimeEvent(
      service,
      'task-1',
      TaskRuntimeEventKind.EXECUTOR_PROCESS_EXITED,
      {
        at: '2026-01-01T00:00:03.000Z',
        exitCode: 127,
        errorCode: 'unexpected_exit',
      }
    );

    expect(patches).toHaveLength(1);
    expect(vitals?.last_event).toMatchObject({
      kind: TaskRuntimeEventKind.EXECUTOR_PROCESS_EXITED,
      exit_code: 127,
      error_code: 'unexpected_exit',
    });
    expect(vitals?.recent_events?.map((event) => event.kind)).toEqual([
      TaskRuntimeEventKind.EXECUTOR_SPAWN_REQUESTED,
      TaskRuntimeEventKind.EXECUTOR_PROCESS_EXITED,
    ]);
    expect(patches[0]?.data).toEqual({ runtime_vitals: vitals });
    expect(patches[0]?.data).not.toHaveProperty('status');
  });

  it('does not rewrite runtime vitals after the task is terminal', async () => {
    const service = {
      get: vi.fn(async () => ({ task_id: 'task-1', status: TaskStatus.COMPLETED }) as Task),
      patch: vi.fn(),
    };

    const vitals = await patchDaemonTaskRuntimeEvent(
      service,
      'task-1',
      TaskRuntimeEventKind.EXECUTOR_PROCESS_SPAWNED,
      {
        at: '2026-01-01T00:00:03.000Z',
        processPid: 12345,
      }
    );

    expect(vitals).toBeUndefined();
    expect(service.patch).not.toHaveBeenCalled();
  });

  it('preserves a newer runtime phase when appending a daemon event to a running task', async () => {
    const task: Partial<Task> = {
      task_id: 'task-1' as never,
      status: TaskStatus.RUNNING,
      runtime_vitals: buildDaemonTaskRuntimeVitals(
        undefined,
        TaskRuntimeEventKind.SDK_TURN_STARTED,
        {
          at: '2026-01-01T00:00:01.000Z',
          phase: TaskRuntimePhase.SDK_STARTING,
        }
      ),
    };
    const service = {
      get: vi.fn(async () => task as Task),
      patch: vi.fn(async (_id: string, data: Partial<Task>) => {
        task.runtime_vitals = data.runtime_vitals;
        return { ...task, ...data } as Task;
      }),
    };

    const vitals = await patchDaemonTaskRuntimeEvent(
      service,
      'task-1',
      TaskRuntimeEventKind.EXECUTOR_PROCESS_SPAWNED,
      {
        at: '2026-01-01T00:00:02.000Z',
      }
    );

    expect(vitals?.phase).toBe(TaskRuntimePhase.SDK_STARTING);
    expect(vitals?.last_event?.phase).toBe(TaskRuntimePhase.SDK_STARTING);
  });
});
