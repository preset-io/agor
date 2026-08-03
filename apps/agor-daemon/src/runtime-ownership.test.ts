import { TASK_RUNTIME_LEASE_MS, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { isStaleRuntimeOwner, newRuntimeOwner } from './runtime-ownership.js';

const now = new Date('2026-08-03T12:00:00.000Z');
const task = (overrides: Partial<Task>): Task =>
  ({
    task_id: 'task',
    session_id: 'session',
    created_by: 'user',
    created_at: now.toISOString(),
    started_at: now.toISOString(),
    status: TaskStatus.RUNNING,
    ...overrides,
  }) as Task;

describe('replica runtime ownership', () => {
  it('creates a bounded fenced lease', () => {
    const owner = newRuntimeOwner(now);
    expect(owner.daemon_id).toBeTruthy();
    expect(owner.fence).toBeTruthy();
    expect(Date.parse(owner.lease_expires_at)).toBe(now.getTime() + TASK_RUNTIME_LEASE_MS);
  });

  it('takes over only after expiry and treats invalid owner timestamps as live', () => {
    const live = task({
      runtime_owner: { daemon_id: 'a', fence: '1', lease_expires_at: '2026-08-03T12:00:01Z' },
    });
    expect(isStaleRuntimeOwner(live, now)).toBe(false);
    expect(isStaleRuntimeOwner(live, new Date('2026-08-03T12:00:01Z'))).toBe(true);
    expect(
      isStaleRuntimeOwner(
        task({ runtime_owner: { daemon_id: 'a', fence: '1', lease_expires_at: 'invalid' } }),
        now
      )
    ).toBe(false);
  });

  it('fails safe for unfenced legacy work during the first rolling upgrade', () => {
    expect(
      isStaleRuntimeOwner(task({}), new Date(now.getTime() + TASK_RUNTIME_LEASE_MS * 100))
    ).toBe(false);
  });
});
