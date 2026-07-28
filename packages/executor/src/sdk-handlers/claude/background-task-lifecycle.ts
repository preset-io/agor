import type { SDKMessage } from '@agor/core/sdk';

export type ResultDisposition = 'not-result' | 'await-background-tasks' | 'terminal';

/**
 * Tracks the documented Agent SDK task lifecycle within one streaming-input
 * query. A `result` ends one model turn, but background tasks may subsequently
 * emit task notifications and wake another model turn on the same query.
 */
export class ClaudeBackgroundTaskLifecycle {
  private readonly activeTaskIds = new Set<string>();

  observe(message: SDKMessage): ResultDisposition {
    if (message.type === 'system' && message.subtype === 'task_started') {
      this.activeTaskIds.add(message.task_id);
      return 'not-result';
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      this.activeTaskIds.delete(message.task_id);
      return 'not-result';
    }

    if (message.type !== 'result') return 'not-result';

    // Error results cannot reliably produce later settlement notifications.
    // Let the normal error/teardown path contain any remaining subprocess work.
    if (message.subtype !== 'success') return 'terminal';

    return this.activeTaskIds.size > 0 ? 'await-background-tasks' : 'terminal';
  }

  get activeTaskCount(): number {
    return this.activeTaskIds.size;
  }
}
