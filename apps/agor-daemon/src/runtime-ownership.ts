import { randomUUID } from 'node:crypto';
import { TASK_RUNTIME_LEASE_MS, type Task } from '@agor/core/types';

// Longer than the default five-minute dispatch connection deadline. Connected
// executors renew it with every heartbeat, including when requests are routed
// through another replica.
export const daemonRuntimeId = randomUUID();

export function newRuntimeOwner(now = new Date()): NonNullable<Task['runtime_owner']> {
  return {
    daemon_id: daemonRuntimeId,
    fence: randomUUID(),
    lease_expires_at: new Date(now.getTime() + TASK_RUNTIME_LEASE_MS).toISOString(),
  };
}

export function isStaleRuntimeOwner(task: Task, now = new Date()): boolean {
  const owner = task.runtime_owner;
  if (owner) {
    const expires = Date.parse(owner.lease_expires_at);
    return Number.isFinite(expires) && expires <= now.getTime();
  }
  // Absence of a fence is not evidence of death. This is deliberately
  // fail-safe during the first rolling upgrade from a pre-lease replica: old
  // work remains untouched and requires explicit operator recovery.
  return false;
}
