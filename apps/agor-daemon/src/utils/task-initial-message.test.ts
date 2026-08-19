import type { MessageID, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  shouldReconcileStableInitialMessage,
  stableInitialMessageIdForTask,
} from './task-initial-message';

describe('stable Task initial-message reconciliation', () => {
  const stableId = 'widget-task-id' as MessageID;

  it('keeps a busy-session widget Task transcript-free until queue drain claims it', () => {
    const queued = {
      status: TaskStatus.QUEUED,
      metadata: { initial_message_id: stableId },
    } as Pick<Task, 'status' | 'metadata'>;

    const resolvedId = stableInitialMessageIdForTask(queued);
    expect(resolvedId).toBe(stableId);
    expect(shouldReconcileStableInitialMessage(queued, resolvedId)).toBe(false);

    const claimed = { ...queued, status: TaskStatus.DISPATCHING };
    expect(shouldReconcileStableInitialMessage(claimed, resolvedId)).toBe(true);
  });

  it('supports legacy scheduled Tasks while preferring persisted identity', () => {
    const persisted = 'persisted-id' as MessageID;
    const fallback = 'scheduled-id' as MessageID;
    expect(
      stableInitialMessageIdForTask({ metadata: { initial_message_id: persisted } }, fallback)
    ).toBe(persisted);
    expect(stableInitialMessageIdForTask({ metadata: undefined }, fallback)).toBe(fallback);
  });
});
