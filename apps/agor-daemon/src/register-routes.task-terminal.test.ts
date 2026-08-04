import { BadRequest } from '@agor/core/feathers';
import { type Task, TaskStatus } from '@agor/core/types';
import { expect, it } from 'vitest';
import { findUnverifiedTerminationTask, rejectRemovedClaudeCliRestart } from './register-routes.js';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from './utils/agentic-tool-runtime.js';

it('selects the unverified active task even when newer queued work exists', () => {
  const stopping = {
    task_id: 'task-stopping',
    status: TaskStatus.STOPPING,
    sdk_failure: { termination: 'unverified' },
  } as Task;
  const queued = { task_id: 'task-queued', status: TaskStatus.QUEUED } as Task;

  expect(findUnverifiedTerminationTask([queued, stopping])).toBe(stopping);
});

it('keeps the stale restart endpoint as an explicit removed-runtime tombstone', () => {
  expect(rejectRemovedClaudeCliRestart).toThrow(BadRequest);
  expect(rejectRemovedClaudeCliRestart).toThrow(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
});
