/**
 * ensureInitialUserMessage
 *
 * Idempotently persists the initial user-message row for a task. Two call
 * sites use it, for two different reasons:
 *
 *   1. `spawnTaskExecutor` calls this pre-spawn (subject to the
 *      `daemon_writes_user_message` kill switch) so the user's prompt
 *      renders in the transcript the instant the task appears, without
 *      waiting for the executor process to connect back.
 *   2. `/sessions/:id/prompt`'s deferred executor error handler calls
 *      this unconditionally so that when the executor process dies
 *      before its own `createUserMessage` runs — an invalid preset
 *      (e.g. sonnet-5 + advisor combo, per 2026-07-13 incident),
 *      missing binary, sandbox refusal, etc. — the transcript still
 *      surfaces the prompt above the "agent failed to start" system
 *      message, instead of leaving the session looking empty with the
 *      prompt buried in `tasks.full_prompt` / `session.description`.
 *
 * Idempotence is checked against the DB (not a local flag), so if the
 * pre-spawn write silently failed (RBAC deny, transient error, kill
 * switch off) the error-path caller can still finish the write.
 *
 * Returns `true` when a new row was written, `false` when one already
 * existed (or when the write itself failed — the caller should treat
 * both as "don't retry synchronously"). The function never throws; a
 * missing user-message row is a UX degradation but must never abort
 * the spawn-failure error path (which is already handling one error).
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Message, MessageSource, Params, SessionID, Task } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { buildInitialUserMessage } from './build-initial-user-message.js';

export interface EnsureInitialUserMessageOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  task: Task;
  /** ISO 8601 timestamp to stamp the message with when a fresh write happens. */
  timestamp: string;
  /** Feathers params (auth/tenant) forwarded to messages.find/messages.create. */
  params: Params;
  /**
   * MessageSource fallback when `task.metadata.source` is unset. Used by the
   * pre-spawn path — the error path just passes undefined since by the time
   * we're recovering, the origin has already been captured on the task row.
   */
  messageSource?: MessageSource;
  /**
   * Session-scoped message-count helper. Callers pass a bound
   * `sessionsRepository.countMessages` so this helper doesn't need to know
   * how to construct a repository. Consulted only when we're actually
   * writing (skip-if-exists short-circuits the count).
   */
  countMessagesForSession: (sessionId: SessionID) => Promise<number>;
}

export async function ensureInitialUserMessage(
  opts: EnsureInitialUserMessageOptions
): Promise<boolean> {
  const { app, task, timestamp, params, messageSource, countMessagesForSession } = opts;
  try {
    // Skip-if-exists guard: a `role === 'user'` row for this task is either
    // the daemon-written initial prompt or an executor-written duplicate.
    // Either way, no fresh write needed. Match on role, not type, because
    // callback prompts land as `type:'system', role:'user'` and matching
    // strictly on `type:'user'` would miss them and double-insert.
    const existing = (await app.service('messages').find({
      ...params,
      query: { task_id: task.task_id, role: MessageRole.USER, $limit: 1 },
      paginate: false,
    } as never)) as Message[] | { data: Message[] };
    const existingRows = Array.isArray(existing) ? existing : (existing.data ?? []);
    if (existingRows.length > 0) return false;

    const isCallback = task.metadata?.is_agor_callback === true;
    const messageMetadata: Message['metadata'] = {};
    if (isCallback) {
      messageMetadata.is_agor_callback = true;
    }
    // Prefer task.metadata.source (set when the task was queued) over the
    // request's messageSource — the former is where the prompt originated;
    // the latter is just the ambient draining tick.
    const source = task.metadata?.source ?? messageSource;
    if (source) {
      messageMetadata.source = source;
    }

    // Recompute the index instead of trusting a caller-scoped constant —
    // the error-path caller might race the executor writing partial rows
    // before dying, so `countMessages` is the only trustworthy anchor.
    const nextIndex = await countMessagesForSession(task.session_id);
    const userMessage = buildInitialUserMessage({
      sessionId: task.session_id,
      taskId: task.task_id,
      index: nextIndex,
      timestamp,
      content: task.full_prompt,
      // Callback messages are typed `system` so the UI shows the special
      // Agor-callback styling. Normal prompts stay `user`.
      type: isCallback ? 'system' : 'user',
      metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
    });
    await app.service('messages').create(userMessage, params);
    return true;
  } catch (err) {
    // Never throw: this helper runs either pre-spawn (where a failure just
    // means the executor's createUserMessage fallback will retry when it
    // connects) or inside the executor spawn-failure catch (where throwing
    // would abort the system-error-message write that follows). Log and move
    // on — the caller can inspect the return value if it cares.
    console.warn(
      `⚠️  [Daemon] Failed to write initial user-message row for task ${task.task_id}:`,
      err
    );
    return false;
  }
}
