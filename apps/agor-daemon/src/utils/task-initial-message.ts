import type { MessageID, Task } from '@agor/core/types';
import { isTaskPendingDispatch } from '@agor/core/types';

/** Resolve the durable transcript identity carried by an idempotent Task. */
export function stableInitialMessageIdForTask(
  task: Pick<Task, 'metadata'>,
  legacyFallback?: MessageID
): MessageID | undefined {
  return task.metadata?.initial_message_id ?? legacyFallback;
}

/** A loser repairs projection only after another claimant crossed the fence. */
export function shouldReconcileStableInitialMessage(
  task: Pick<Task, 'status'>,
  stableMessageId: MessageID | undefined
): stableMessageId is MessageID {
  return stableMessageId !== undefined && !isTaskPendingDispatch(task);
}
