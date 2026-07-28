import type { SDKMessage } from '@agor/core/sdk';

type ResultDisposition = 'not-result' | 'await-background-tasks' | 'terminal';

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
      return {
        resultDisposition: 'not-result',
        taskTransition: this.activeTaskIds.delete(message.task_id) ? 'settled' : undefined,
      };
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
}
