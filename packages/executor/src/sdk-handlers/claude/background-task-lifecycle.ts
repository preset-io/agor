import type { SDKMessage } from '@agor/core/sdk';

type ResultDisposition = 'not-result' | 'await-background-tasks' | 'terminal';
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Stable identifier for the rare "the agent ended its turn with background work
 * still running, and it never reported completion within the budget" event. It
 * is the `sdkSubtype` of the surfaced system message, the token the executor
 * uses to flag the settled Task, and how the daemon counts the occurrence — one
 * shared string so those three stay in lock-step. Grep `background_task_timeout`
 * to find every leg.
 */
export const BACKGROUND_TASK_TIMEOUT_EVENT = 'background_task_timeout';

export interface ClaudeQueryLifecycleTransition {
  resultDisposition: ResultDisposition;
  taskTransition?: 'started' | 'settled';
}

/**
 * Tracks the documented Agent SDK task lifecycle within one streaming-input
 * query. A `result` ends one model turn, but background tasks may subsequently
 * emit task notifications and wake another model turn on the same query.
 */
export class ClaudeBackgroundTaskLifecycle {
  private readonly activeTaskIds = new Set<string>();

  observe(message: SDKMessage): ClaudeQueryLifecycleTransition {
    if (message.type === 'system' && message.subtype === 'task_started') {
      const wasActive = this.activeTaskIds.has(message.task_id);
      this.activeTaskIds.add(message.task_id);
      return {
        resultDisposition: 'not-result',
        taskTransition: wasActive ? undefined : 'started',
      };
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      if (!TERMINAL_TASK_STATUSES.has(message.status)) {
        return { resultDisposition: 'not-result' };
      }
      return this.settleTask(message.task_id);
    }

    // A task that settles while the model is still handling other tool calls
    // may be reported only as task_updated. In that ordering the SDK does not
    // necessarily emit a later task_notification, so both documented terminal
    // signals must reconcile the same query-scoped task ID.
    if (
      message.type === 'system' &&
      message.subtype === 'task_updated' &&
      typeof message.patch.status === 'string' &&
      TERMINAL_TASK_STATUSES.has(message.patch.status)
    ) {
      return this.settleTask(message.task_id);
    }

    if (message.type !== 'result') return { resultDisposition: 'not-result' };

    // Error results cannot reliably produce later settlement notifications.
    // Let the normal error/teardown path contain any remaining subprocess work.
    if (message.subtype !== 'success') return { resultDisposition: 'terminal' };

    return {
      resultDisposition: this.activeTaskIds.size > 0 ? 'await-background-tasks' : 'terminal',
    };
  }

  get activeTaskCount(): number {
    return this.activeTaskIds.size;
  }

  clearActiveTasks(): number {
    const count = this.activeTaskIds.size;
    this.activeTaskIds.clear();
    return count;
  }

  private settleTask(taskId: string): ClaudeQueryLifecycleTransition {
    const settled = this.activeTaskIds.delete(taskId);
    return {
      resultDisposition: 'not-result',
      taskTransition: settled ? 'settled' : undefined,
    };
  }
}
