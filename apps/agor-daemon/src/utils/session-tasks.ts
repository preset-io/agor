/**
 * Helpers for finding "active" tasks for a session — RUNNING /
 * AWAITING_PERMISSION / STOPPING — sorted by recency.
 *
 * Background: `TasksService.find()` short-circuits on `session_id: string`
 * (see `services/tasks.ts:65-110`) and returns ALL session tasks in
 * `created_at` ASC, ignoring any `status` filter or `$sort` passed in the
 * same query. So callers can't write `{ session_id, status: RUNNING }`
 * and trust the result. We instead fetch the full session task list once
 * and filter/sort in process.
 *
 * Without this helper, multiple sites (widget MCP tool, stop route,
 * potentially more) end up with parallel hand-rolled workarounds that
 * drift. Keep this as the single source.
 */

import {
  eq,
  lockRowForUpdate,
  MessagesRepository,
  TaskRepository,
  tasks as tasksTable,
  txAsDb,
} from '@agor/core/db';
import type { Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Message, Paginated, Params, SessionID, Task, TaskID } from '@agor/core/types';
import { MessageRole, TaskStatus } from '@agor/core/types';

/** Statuses considered "active" — an executor may still be doing work. */
export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set<string>([
  TaskStatus.RUNNING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.STOPPING,
]);

function recencyKey(t: Task): number {
  return new Date(t.started_at || t.created_at).getTime();
}

/**
 * All tasks for the session, returned in recency-DESC order (most recently
 * started/created first). Useful when callers want a fallback path.
 */
export async function findTasksForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task[]> {
  const result = (await app.service('tasks').find({
    ...(params ?? {}),
    // Merge defensively: spread params first, then force session_id so a
    // caller-supplied params.query can never silently overwrite the filter.
    query: {
      ...(params?.query as Record<string, unknown> | undefined),
      session_id: sessionId,
      $limit: (params?.query as Record<string, unknown> | undefined)?.$limit ?? 1000,
    },
  })) as Paginated<Task> | Task[];
  const tasks = Array.isArray(result) ? result : result.data;
  return [...tasks].sort((a, b) => recencyKey(b) - recencyKey(a));
}

/**
 * The session's active tasks (RUNNING / AWAITING_PERMISSION / STOPPING),
 * recency-DESC. Empty when nothing is active.
 */
export async function findActiveTasksForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task[]> {
  const all = await findTasksForSession(app, sessionId, params);
  return all.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
}

/**
 * The single most-recent active task — preferred when callers want "the
 * task that is driving this session right now." Falls back to the most-
 * recent task of any status when nothing is active, so widget messages /
 * system messages always land somewhere visible to the transcript renderer.
 *
 * Returns `undefined` when the session has no tasks at all (brand-new
 * session).
 */
export async function findHostTaskForSession(
  app: Application,
  sessionId: SessionID,
  params?: Params
): Promise<Task | undefined> {
  const all = await findTasksForSession(app, sessionId, params);
  if (all.length === 0) return undefined;
  return all.find((t) => ACTIVE_TASK_STATUSES.has(t.status)) ?? all[0];
}

/**
 * Predicate: have we seen any user-visible output from the agent on this
 * task yet? `text` and `tool_use` content blocks (or non-empty string
 * content on an ASSISTANT message) count. Pure `thinking`,
 * `system_status`, and other internal-only blocks do NOT — matching
 * Claude Code CLI's "single-Esc while still internal" carve-out.
 *
 * Used by the stop route to decide between "edit-on-cancel" (drop the
 * orphan task, hand the prompt back) and the regular "mark STOPPED"
 * path. Centralized here to keep the definition single-sourced — other
 * call sites that need "has this task started producing visible output"
 * should reuse this instead of growing parallel checks.
 */
export function hasAgentOutput(messages: ReadonlyArray<Message>): boolean {
  return messages.some((msg) => {
    if (msg.role !== MessageRole.ASSISTANT) return false;
    const content = msg.content;
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) {
      return content.some((block) => block.type === 'text' || block.type === 'tool_use');
    }
    return false;
  });
}

/**
 * Outcome of {@link discardTaskIfNoOutput}. The `discarded` branch is the
 * only one that mutates DB state.
 *
 * Contract: callers MUST fire `messages.removed` for each row in
 * `removedMessages` and `tasks.removed` for `task` after the call returns —
 * the helper deliberately stays at the repo layer to keep its DELETEs
 * atomic, so the matching WebSocket events are the caller's responsibility.
 * `removedMessages` is the set-based DELETE's `RETURNING` output, so it
 * includes any executor stragglers that landed between the predicate read
 * and the DELETE.
 */
export type DiscardTaskOutcome =
  | { kind: 'discarded'; removedMessages: Message[]; task: Task }
  | { kind: 'has_output' }
  | { kind: 'not_found' };

/**
 * Atomically drop a task and all its messages if the agent hasn't
 * produced user-visible output yet. Wraps the predicate read + both
 * deletes in a single DB transaction so a stray late executor write
 * either lands before the read (caught by `hasAgentOutput`, leaves the
 * task as STOPPED) or after — in which case the set-based
 * `deleteByTaskId` returns it too, so the caller can emit the matching
 * `removed` event and the UI reactively prunes the late bubble.
 *
 * On Postgres, the function acquires `SELECT ... FOR UPDATE` on the task
 * row at the top of the transaction so concurrent executor writes block
 * until commit; on SQLite this is a no-op (the dialect serializes writes
 * implicitly via its single-writer transaction model).
 */
export async function discardTaskIfNoOutput(
  db: Database,
  taskId: TaskID
): Promise<DiscardTaskOutcome> {
  return await db.transaction(async (tx) => {
    const txDb = txAsDb(tx);
    const txTasksRepo = new TaskRepository(txDb);
    const txMessagesRepo = new MessagesRepository(txDb);

    const task = await txTasksRepo.findById(taskId);
    if (!task) return { kind: 'not_found' };

    // Block concurrent executor writes from racing the predicate check
    // on Postgres. SQLite's transaction model already serializes writes.
    await lockRowForUpdate(txDb, db, tasksTable, eq(tasksTable.task_id, task.task_id));

    const messages = await txMessagesRepo.findByTaskId(taskId);
    if (hasAgentOutput(messages)) return { kind: 'has_output' };

    // Set-based DELETE with RETURNING: the returned rows are the
    // ground-truth list of what was actually removed, including any
    // stragglers the executor flushed after the predicate read but
    // before this statement. Use these for emitting `removed` events.
    const removedMessages = await txMessagesRepo.deleteByTaskId(taskId);
    await txTasksRepo.delete(taskId);

    return { kind: 'discarded', removedMessages, task };
  });
}
