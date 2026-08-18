import type { SDKMessage } from '@agor/core/sdk';
import { getSdkActivityVersion } from '../../sdk-watchdog.js';
import { classifyTurnScope } from './message-scope.js';

type ResultDisposition = 'not-result' | 'await-background-tasks' | 'terminal';

type TaskNotificationMessage = Extract<SDKMessage, { subtype: 'task_notification' }>;
type TaskUpdatedMessage = Extract<SDKMessage, { subtype: 'task_updated' }>;
type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;

/**
 * The two documented terminal signals carry *different* status enums, so one
 * shared set misreads both: `task_updated.patch.status` can be `killed` — which
 * a set built for notifications never matched, leaking the task ID forever —
 * and can never be `stopped`, which only `task_notification.status` reports.
 *
 * Each enum is written out exhaustively as a `Record` keyed by the SDK type, so
 * a status the SDK adds or renames is a compile error here instead of a turn
 * that waits forever for a signal that can no longer arrive.
 */
const NOTIFICATION_STATUS_IS_TERMINAL: Record<TaskNotificationMessage['status'], boolean> = {
  completed: true,
  failed: true,
  stopped: true,
};

const UPDATED_STATUS_IS_TERMINAL: Record<
  NonNullable<TaskUpdatedMessage['patch']['status']>,
  boolean
> = {
  completed: true,
  failed: true,
  killed: true,
  paused: false,
  pending: false,
  running: false,
};

/** Wire data can carry a status newer than the checked-in types; treat it as non-terminal. */
function isTerminal(table: Record<string, boolean>, status: unknown): boolean {
  return typeof status === 'string' && table[status] === true;
}

export interface ClaudeQueryLifecycleTransition {
  resultDisposition: ResultDisposition;
  taskTransition?: 'started' | 'settled';
  /**
   * How many tracked tasks this one message settled. Always 1 for the
   * documented terminal signals; a single message can retire several tasks only
   * on the nested-launch path below. Watchdog accounting needs the real count
   * so every `background_task.start` gets its matching completion.
   */
  settledTaskCount?: number;
}

/**
 * Tracks the documented Agent SDK task lifecycle within one streaming-input
 * query. A `result` ends one model turn, but background tasks may subsequently
 * emit task notifications and wake another model turn on the same query.
 */
export class ClaudeBackgroundTaskLifecycle {
  /** Task ID -> the tool_use block that launched it (when the SDK reports one). */
  private readonly activeTasks = new Map<string, string | undefined>();
  /** tool_use IDs observed inside a subagent's own messages (see `observeToolUses`). */
  private readonly nestedToolUseIds = new Set<string>();

  observe(message: SDKMessage): ClaudeQueryLifecycleTransition {
    // Only a task launched by the top-level turn can settle on this stream, so
    // learn which tool_use blocks belong to a subagent's conversation instead.
    // A message we cannot place is deliberately not treated as a subagent's:
    // mislabelling one top-level turn that way would drop every task it
    // launched and close the query on live background work.
    if (message.type === 'assistant' && classifyTurnScope(message) === 'subagent') {
      return this.observeNestedToolUses(message);
    }

    if (message.type === 'system' && message.subtype === 'task_started') {
      if (message.tool_use_id !== undefined && this.nestedToolUseIds.has(message.tool_use_id)) {
        console.log(
          `[claude.background_task] event=nested_task_excluded task_id=${message.task_id} ` +
            `tool_use_id=${message.tool_use_id} sdk=${getSdkActivityVersion('claude-code')}`
        );
        return { resultDisposition: 'not-result' };
      }
      const wasActive = this.activeTasks.has(message.task_id);
      this.activeTasks.set(message.task_id, message.tool_use_id);
      return {
        resultDisposition: 'not-result',
        taskTransition: wasActive ? undefined : 'started',
      };
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      if (!isTerminal(NOTIFICATION_STATUS_IS_TERMINAL, message.status)) {
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
      isTerminal(UPDATED_STATUS_IS_TERMINAL, message.patch.status)
    ) {
      return this.settleTask(message.task_id);
    }

    if (message.type !== 'result') return { resultDisposition: 'not-result' };

    // Error results cannot reliably produce later settlement notifications.
    // Let the normal error/teardown path contain any remaining subprocess work.
    if (message.subtype !== 'success') return { resultDisposition: 'terminal' };

    return {
      resultDisposition: this.activeTasks.size > 0 ? 'await-background-tasks' : 'terminal',
    };
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /** IDs still waiting on a terminal signal — the evidence a leak needs. */
  get activeTaskIds(): string[] {
    return [...this.activeTasks.keys()];
  }

  clearActiveTasks(): number {
    const count = this.activeTasks.size;
    this.activeTasks.clear();
    return count;
  }

  /**
   * A subagent's own `tool_use` blocks are forwarded on the parent stream with
   * `parent_tool_use_id` set. A task launched from one of those blocks is
   * nested (spawn depth >= 2): the SDK announces its `task_started` here but
   * routes its terminal signal to the subagent that owns it, so tracking it
   * would hold the query open for a settlement that never arrives. The
   * ancestor task we do track already covers the nested task's whole lifetime,
   * so dropping it costs no protection.
   *
   * Either ordering is safe: a nested `task_started` seen after its launch site
   * is never tracked, and one seen before is settled here.
   */
  private observeNestedToolUses(message: AssistantMessage): ClaudeQueryLifecycleTransition {
    const content = message.message?.content;
    if (!Array.isArray(content)) return { resultDisposition: 'not-result' };
    let settledTaskCount = 0;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      this.nestedToolUseIds.add(block.id);
      for (const [taskId, toolUseId] of this.activeTasks) {
        if (toolUseId !== block.id) continue;
        this.activeTasks.delete(taskId);
        settledTaskCount++;
      }
    }
    if (settledTaskCount === 0) return { resultDisposition: 'not-result' };
    return { resultDisposition: 'not-result', taskTransition: 'settled', settledTaskCount };
  }

  private settleTask(taskId: string): ClaudeQueryLifecycleTransition {
    if (!this.activeTasks.delete(taskId)) return { resultDisposition: 'not-result' };
    return { resultDisposition: 'not-result', taskTransition: 'settled', settledTaskCount: 1 };
  }
}
