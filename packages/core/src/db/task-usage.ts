/**
 * Per-task usage for analytics aggregates.
 *
 * Some agentic tools record the session's running total on each Task rather
 * than the Task's own usage, so summing `normalized_sdk_response` across a
 * session's Tasks over-counts:
 *
 * - claude-code: `costUsd` is the Agent SDK `total_cost_usd`, which carries
 *   across the resumed queries of one SDK session. Its token counts are summed
 *   per turn by the executor and are per Task.
 * - codex: `costUsd` and every `tokenUsage` counter come from
 *   `turn.completed.usage`, which is the thread's running total.
 *
 * Gemini and Copilot record per-Task usage. For a running total, a Task's own
 * usage is its value minus the previous reported value in the same session,
 * in completion order; a fork's first value is measured against its parent's
 * value when it ran. A value below the baseline is a reset (for example a
 * fresh SDK session), so the value itself is the Task's usage. Tasks that
 * report nothing (stopped, crashed, legacy) contribute 0 and leave the
 * baseline unchanged.
 */

import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { type AgenticToolName, type SessionID, TaskStatus } from '../types';
import type { Database } from './client';
import { jsonExtract } from './database-wrapper';
import { sessions, tasks } from './schema';

export const TASK_USAGE_METRICS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsd',
] as const;
export type TaskUsageMetric = (typeof TASK_USAGE_METRICS)[number];

const METRIC_PATHS: Record<TaskUsageMetric, string> = {
  inputTokens: 'normalized_sdk_response.tokenUsage.inputTokens',
  outputTokens: 'normalized_sdk_response.tokenUsage.outputTokens',
  totalTokens: 'normalized_sdk_response.tokenUsage.totalTokens',
  cacheReadTokens: 'normalized_sdk_response.tokenUsage.cacheReadTokens',
  cacheCreationTokens: 'normalized_sdk_response.tokenUsage.cacheCreationTokens',
  costUsd: 'normalized_sdk_response.costUsd',
};

/** Agentic tools whose Tasks record a session running total, per metric. */
export const SESSION_CUMULATIVE_USAGE_METRICS: Readonly<
  Partial<Record<AgenticToolName, readonly TaskUsageMetric[]>>
> = {
  'claude-code': ['costUsd'],
  codex: TASK_USAGE_METRICS,
};

function toolsReportingCumulative(metric: TaskUsageMetric): AgenticToolName[] {
  return (Object.keys(SESSION_CUMULATIVE_USAGE_METRICS) as AgenticToolName[]).filter((tool) =>
    SESSION_CUMULATIVE_USAGE_METRICS[tool]?.includes(metric)
  );
}

function reportedValue(db: Database, data: unknown, metric: TaskUsageMetric): SQL {
  return sql`CAST(${jsonExtract(db, data, METRIC_PATHS[metric])} AS DOUBLE PRECISION)`;
}

function perTaskUsage(db: Database, metric: TaskUsageMetric): SQL {
  const value = reportedValue(db, tasks.data, metric);
  const cumulativeTools = toolsReportingCumulative(metric);
  if (cumulativeTools.length === 0) return value;
  // Partitioning on "reported a value" makes LAG skip Tasks that reported
  // nothing, so they neither count nor reset the baseline.
  const previous = sql`LAG(${value}) OVER (
    PARTITION BY ${tasks.session_id}, CASE WHEN ${value} > 0 THEN 1 ELSE 0 END
    ORDER BY COALESCE(${tasks.completed_at}, ${tasks.created_at}), ${tasks.task_id}
  )`;
  // Freeze the inherited baseline at the fork's first execution, even when
  // that Task reports no metric (or only zero counters). A later report must
  // not inherit parent activity that happened after the fork began. Queued
  // tasks can predate execution by arbitrarily long periods.
  const forkStartedAt = sql`(
    SELECT MIN(COALESCE(fork_task.started_at, fork_task.created_at)) FROM ${tasks} fork_task
    WHERE fork_task.session_id = ${tasks.session_id}
      AND fork_task.status NOT IN (${TaskStatus.CREATED}, ${TaskStatus.QUEUED})
  )`;
  // A fork resumes its parent's SDK session, so its first reported value
  // includes the parent's running total as of the parent's last completed Task.
  const parentValue = reportedValue(db, sql.raw('fork_parent.data'), metric);
  const parentBaseline = sql`(
    SELECT ${parentValue} FROM ${tasks} fork_parent
    WHERE fork_parent.session_id = ${sessions.forked_from_session_id}
      AND ${parentValue} > 0
      AND COALESCE(fork_parent.completed_at, fork_parent.created_at)
        <= ${forkStartedAt}
    ORDER BY COALESCE(fork_parent.completed_at, fork_parent.created_at) DESC, fork_parent.task_id DESC
    LIMIT 1
  )`;
  const baseline = sql`CASE
    WHEN ${previous} IS NOT NULL THEN ${previous}
    WHEN ${sessions.forked_from_session_id} IS NOT NULL THEN ${parentBaseline}
  END`;
  return sql`CASE
    WHEN ${inArray(sessions.agentic_tool, cumulativeTools)} THEN
      CASE
        WHEN ${value} > 0 THEN ${value} - CASE WHEN ${baseline} <= ${value} THEN ${baseline} ELSE 0 END
        ELSE 0
      END
    ELSE ${value}
  END`;
}

/**
 * A derived table with one row per Task (`task_id`, `session_id`) and its own
 * usage in each metric column (`usage_input_tokens`, `usage_output_tokens`,
 * `usage_total_tokens`, `usage_cache_read_tokens`,
 * `usage_cache_creation_tokens`, `usage_cost_usd`).
 * The running-total baseline is computed over every Task of the session, so
 * join this table and filter the outer query; `sessionId` may only narrow it
 * to whole sessions.
 */
export function taskUsageTable(db: Database, options: { sessionId?: SessionID } = {}) {
  const where: SQL[] = [];
  if (options.sessionId) where.push(eq(tasks.session_id, options.sessionId));
  // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
  return (db as any)
    .select({
      task_id: tasks.task_id,
      session_id: tasks.session_id,
      usage_input_tokens: sql<number>`${perTaskUsage(db, 'inputTokens')}`.as('usage_input_tokens'),
      usage_output_tokens: sql<number>`${perTaskUsage(db, 'outputTokens')}`.as(
        'usage_output_tokens'
      ),
      usage_total_tokens: sql<number>`${perTaskUsage(db, 'totalTokens')}`.as('usage_total_tokens'),
      usage_cache_read_tokens: sql<number>`${perTaskUsage(db, 'cacheReadTokens')}`.as(
        'usage_cache_read_tokens'
      ),
      usage_cache_creation_tokens: sql<number>`${perTaskUsage(db, 'cacheCreationTokens')}`.as(
        'usage_cache_creation_tokens'
      ),
      usage_cost_usd: sql<number>`${perTaskUsage(db, 'costUsd')}`.as('usage_cost_usd'),
    })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
    .where(where.length > 0 ? and(...where) : undefined)
    .as('task_usage');
}
