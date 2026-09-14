import type { SDKMessage } from '@agor/core/sdk';

type ResultDisposition = 'not-result' | 'await-background-tasks' | 'terminal';

// Terminal background-task states across BOTH documented settlement signals.
// `task_notification.status` reports `completed | failed | stopped`;
// `task_updated.patch.status` reports `completed | failed | killed` (plus the
// non-terminal `pending | running | paused`). The union covers either message —
// each only ever emits its own subset — so a task that settles as `killed` and
// is reported only via `task_updated` still drains instead of waiting out the
// active-task timeout.
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);

/**
 * Stable identifier for the rare "the agent ended its turn with background work
 * still running, and it never reported completion within the budget" event.
 * Shared by the executor's structured operational log (`event=…`) and the
 * `sdkSubtype` of the conversation notice it surfaces, so the greppable token
 * and the queryable message subtype stay in lock-step.
 */
export const BACKGROUND_TASK_TIMEOUT_EVENT = 'background_task_timeout';

export interface ClaudeQueryLifecycleTransition {
  resultDisposition: ResultDisposition;
  tasksStarted?: number;
  tasksSettled?: number;
}

/**
 * Tracks the documented Agent SDK task lifecycle within one streaming-input
 * query. A `result` ends one model turn, but background tasks may subsequently
 * emit task notifications and wake another model turn on the same query.
 */
export class ClaudeBackgroundTaskLifecycle {
  private readonly activeTaskIds = new Set<string>();
  private readonly ambientTaskIds = new Set<string>();

  observe(message: SDKMessage): ClaudeQueryLifecycleTransition {
    if (message.type === 'system' && message.subtype === 'task_started') {
      // Ambient housekeeping (including live-update watchers) can outlive a
      // model turn indefinitely. The SDK explicitly excludes it from host
      // activity indicators, so it must not hold Agor's task/watchdog open.
      if (message.ambient === true || message.skip_transcript === true) {
        this.activeTaskIds.delete(message.task_id);
        this.ambientTaskIds.add(message.task_id);
        return { resultDisposition: 'not-result' };
      }
      // Newer SDKs also emit task_started for foreground tasks. Only a task
      // that is actually backgrounded should keep the query and watchdog open.
      if (message.is_backgrounded === false) {
        return { resultDisposition: 'not-result' };
      }
      const wasActive = this.activeTaskIds.has(message.task_id);
      this.activeTaskIds.add(message.task_id);
      return {
        resultDisposition: 'not-result',
        tasksStarted: wasActive ? undefined : 1,
      };
    }

    // Added in Agent SDK 0.3.203. This is the authoritative level signal for
    // background work: replace our set instead of pairing potentially-missed
    // task_started/task_notification edges. Those edges remain as a fallback
    // for older CLI processes and are deduplicated whichever event arrives first.
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      const nextTaskIds = new Set(
        message.tasks
          .filter((task) => task.ambient !== true)
          .map((task) => task.task_id)
          .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
      );
      const nextAmbientTaskIds = new Set(
        message.tasks.filter((task) => task.ambient === true).map((task) => task.task_id)
      );
      let tasksStarted = 0;
      let tasksSettled = 0;
      for (const taskId of nextTaskIds) {
        if (!this.activeTaskIds.has(taskId)) tasksStarted++;
      }
      for (const taskId of this.activeTaskIds) {
        if (!nextTaskIds.has(taskId)) tasksSettled++;
      }
      this.activeTaskIds.clear();
      for (const taskId of nextTaskIds) this.activeTaskIds.add(taskId);
      this.ambientTaskIds.clear();
      for (const taskId of nextAmbientTaskIds) this.ambientTaskIds.add(taskId);
      return {
        resultDisposition: 'not-result',
        tasksStarted: tasksStarted || undefined,
        tasksSettled: tasksSettled || undefined,
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

    if (
      message.type === 'system' &&
      message.subtype === 'task_updated' &&
      message.patch.is_backgrounded === true
    ) {
      if (this.ambientTaskIds.has(message.task_id)) {
        return { resultDisposition: 'not-result' };
      }
      const wasActive = this.activeTaskIds.has(message.task_id);
      this.activeTaskIds.add(message.task_id);
      return {
        resultDisposition: 'not-result',
        tasksStarted: wasActive ? undefined : 1,
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
    this.ambientTaskIds.clear();
    return count;
  }

  private settleTask(taskId: string): ClaudeQueryLifecycleTransition {
    this.ambientTaskIds.delete(taskId);
    const settled = this.activeTaskIds.delete(taskId);
    return {
      resultDisposition: 'not-result',
      tasksSettled: settled ? 1 : undefined,
    };
  }
}
