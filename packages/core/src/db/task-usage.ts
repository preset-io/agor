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

import { and, eq, inArray, isNotNull, type SQL, Subquery, sql } from 'drizzle-orm';
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

// Only scalar identifiers and values cross the window/sort boundary, never Task.data.
function reportedColumn(name: string): SQL {
  return sql`${sql.identifier('reported_usage')}.${sql.identifier(name)}`;
}

function perTaskUsage(metric: TaskUsageMetric): SQL {
  const value = reportedColumn(metric);
  const cumulativeTools = toolsReportingCumulative(metric);
  if (cumulativeTools.length === 0) return value;
  // Partitioning on "reported a value" makes LAG skip Tasks that reported
  // nothing, so they neither count nor reset the baseline.
  const previous = sql`LAG(${value}) OVER (
    PARTITION BY ${reportedColumn('session_id')}, CASE WHEN ${value} > 0 THEN 1 ELSE 0 END
    ORDER BY ${reportedColumn('finished_at')}, ${reportedColumn('task_id')}
  )`;
  const baseline = sql`COALESCE(${previous}, ${reportedColumn(`inherited_${metric}`)})`;
  return sql`CASE
    WHEN ${inArray(reportedColumn('agentic_tool'), cumulativeTools)} THEN
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
 * join this table and filter the outer query. Narrow the window input only to
 * WHOLE sessions (either one sessionId or a matchingSessionIds subquery). A task
 * filter inside the window would lose earlier baselines.
 */
export function taskUsageTable(
  db: Database,
  options: { sessionId?: SessionID; matchingSessionIds?: SQL } = {}
) {
  const where: SQL[] = [];
  if (options.sessionId) where.push(eq(tasks.session_id, options.sessionId));
  if (options.matchingSessionIds) {
    where.push(sql`${tasks.session_id} IN (${options.matchingSessionIds})`);
  }
  const forkWhere: SQL[] = [isNotNull(sessions.forked_from_session_id)];
  if (options.sessionId) forkWhere.push(eq(sessions.session_id, options.sessionId));
  if (options.matchingSessionIds) {
    forkWhere.push(sql`${sessions.session_id} IN (${options.matchingSessionIds})`);
  }
  // Freeze inheritance at the first execution, including missing/zero reports.
  // Aggregate once per fork, never inside a parent-row/metric subquery.
  // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
  const forks = (db as any)
    .select({
      session_id: sessions.session_id,
      parent_session_id: sql`${sessions.forked_from_session_id}`.as('parent_session_id'),
      started_at: sql`MIN(COALESCE(${tasks.started_at}, ${tasks.created_at}))`.as('started_at'),
    })
    .from(sessions)
    .innerJoin(tasks, eq(tasks.session_id, sessions.session_id))
    .where(
      and(...forkWhere, sql`${tasks.status} NOT IN (${TaskStatus.CREATED}, ${TaskStatus.QUEUED})`)
    )
    .groupBy(sessions.session_id, sessions.forked_from_session_id);

  // Parent reports are independent of the task/date filters: a qualifying fork
  // can inherit from a parent entirely outside the selected window. Extract
  // each parent's JSON only once even when hundreds of forks share it.
  // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
  const parents = (db as any)
    .select({
      task_id: tasks.task_id,
      session_id: tasks.session_id,
      finished_at: sql`COALESCE(${tasks.completed_at}, ${tasks.created_at})`.as('finished_at'),
      ...Object.fromEntries(
        TASK_USAGE_METRICS.map((metric) => [
          metric,
          reportedValue(db, tasks.data, metric).as(metric),
        ])
      ),
    })
    .from(tasks)
    .where(sql`${tasks.session_id} IN (SELECT parent_session_id FROM fork_starts)`);

  // Rank the narrow parent history once. The baseline joins use the latest
  // positive ordinal for each metric, not the largest value (resets can drop).
  const parentOrder = sql`SELECT *, ROW_NUMBER() OVER (
    PARTITION BY session_id ORDER BY finished_at, task_id
  ) AS report_order FROM parent_values`;
  // Unpivot only the already-extracted scalars, not Task.data. This lets all
  // metrics share one baseline join instead of six multiplying join estimates.
  const parentMetrics = sql.join(
    TASK_USAGE_METRICS.map(
      (metric) => sql`
    SELECT session_id, finished_at, report_order, ${metric} AS metric_name,
      ${sql.identifier(metric)} AS value FROM parent_reports
  `
    ),
    sql` UNION ALL `
  );
  const metricNames = sql.join(
    TASK_USAGE_METRICS.map(
      (metric) => sql`
    SELECT ${metric} AS metric_name
  `
    ),
    sql` UNION ALL `
  );
  // Merge fork starts into the parent timeline before filling positive report
  // ordinals. This avoids a parentTasks × forkCount intermediate. Parent events
  // sort first at equal timestamps, so completion exactly at fork start counts.
  const parentEvents = sql`SELECT session_id, finished_at AS event_at, 0 AS event_kind,
      report_order, NULL AS fork_session_id, metric_name, value
    FROM parent_metrics
    UNION ALL
    SELECT parent_session_id, started_at, 1, NULL, session_id, metric_name, NULL
    FROM fork_starts CROSS JOIN metric_names`;
  const history = sql`SELECT fork_session_id, session_id AS parent_session_id, metric_name,
    MAX(CASE WHEN value > 0 THEN report_order END) OVER (
      PARTITION BY session_id, metric_name ORDER BY event_at, event_kind, report_order
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS report_order
    FROM parent_events`;
  const latest = sql`SELECT * FROM parent_history WHERE fork_session_id IS NOT NULL`;
  const baselines = sql`SELECT fork_latest.fork_session_id AS session_id,
    ${sql.join(
      TASK_USAGE_METRICS.map(
        (metric) => sql`
      MAX(CASE WHEN fork_latest.metric_name = ${metric} THEN parent_metrics.value END)
        AS ${sql.identifier(metric)}
    `
      ),
      sql`, `
    )}
    FROM fork_latest
    LEFT JOIN parent_metrics ON parent_metrics.session_id = fork_latest.parent_session_id
      AND parent_metrics.metric_name = fork_latest.metric_name
      AND parent_metrics.report_order = fork_latest.report_order
    GROUP BY fork_latest.fork_session_id`;

  // Materialize the narrow extraction so both engines evaluate each JSON path
  // once, rather than carrying wide data through six window sorts or inlining
  // the same JSON extraction at every use of a metric in the CASE expressions.
  // The CTE lives inside this derived table and uses the caller's scoped handle;
  // PostgreSQL RLS still applies to its task/session reads and parent lookups.
  // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
  const reported = (db as any)
    .select({
      task_id: tasks.task_id,
      session_id: tasks.session_id,
      finished_at: sql`COALESCE(${tasks.completed_at}, ${tasks.created_at})`.as('finished_at'),
      agentic_tool: sessions.agentic_tool,
      ...Object.fromEntries(
        TASK_USAGE_METRICS.map((metric) => [
          metric,
          reportedValue(db, tasks.data, metric).as(metric),
        ])
      ),
      ...Object.fromEntries(
        TASK_USAGE_METRICS.map((metric) => [
          `inherited_${metric}`,
          sql`${sql.identifier('fork_baselines')}.${sql.identifier(metric)}`.as(
            `inherited_${metric}`
          ),
        ])
      ),
    })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
    .leftJoin(sql`fork_baselines`, eq(sessions.session_id, sql`fork_baselines.session_id`))
    .where(where.length > 0 ? and(...where) : undefined);

  const reportedFields = reported.as('reported_usage');
  const reportedSource = new Subquery(
    sql`WITH fork_starts AS MATERIALIZED (${forks.getSQL()}),
        parent_values AS MATERIALIZED (${parents.getSQL()}),
        parent_reports AS MATERIALIZED (${parentOrder}),
        parent_metrics AS MATERIALIZED (${parentMetrics}),
        metric_names AS (${metricNames}),
        parent_events AS (${parentEvents}),
        parent_history AS (${history}),
        fork_latest AS MATERIALIZED (${latest}),
        fork_baselines AS MATERIALIZED (${baselines}),
        reported_usage AS MATERIALIZED (${reported.getSQL()})
        SELECT * FROM reported_usage`,
    reported.getSelectedFields(),
    'reported_usage',
    false,
    reportedFields._.usedTables
  );

  // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
  return (db as any)
    .select({
      task_id: reportedFields.task_id,
      session_id: reportedFields.session_id,
      usage_input_tokens: sql<number>`${perTaskUsage('inputTokens')}`.as('usage_input_tokens'),
      usage_output_tokens: sql<number>`${perTaskUsage('outputTokens')}`.as('usage_output_tokens'),
      usage_total_tokens: sql<number>`${perTaskUsage('totalTokens')}`.as('usage_total_tokens'),
      usage_cache_read_tokens: sql<number>`${perTaskUsage('cacheReadTokens')}`.as(
        'usage_cache_read_tokens'
      ),
      usage_cache_creation_tokens: sql<number>`${perTaskUsage('cacheCreationTokens')}`.as(
        'usage_cache_creation_tokens'
      ),
      usage_cost_usd: sql<number>`${perTaskUsage('costUsd')}`.as('usage_cost_usd'),
    })
    .from(reportedSource)
    .as('task_usage');
}
