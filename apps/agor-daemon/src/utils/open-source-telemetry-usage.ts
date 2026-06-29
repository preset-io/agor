import { loadConfig, saveConfig } from '@agor/core/config';
import {
  and,
  branches,
  count,
  eq,
  gte,
  lt,
  runWithTenantDatabaseScope,
  select,
  sessions,
  type TenantScopeAwareDatabase,
  tasks,
} from '@agor/core/db';
import {
  normalizeTelemetryModelFamily,
  normalizeTelemetryProvider,
  openSourceTelemetryLogger,
  pruneDefaultOpenSourceTelemetryDestination,
} from '@agor/core/telemetry';
import type { Session, TenantID } from '@agor/core/types';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

interface TaskUsageRow {
  taskData: {
    model?: string;
  } | null;
  agenticTool: string | null;
  sessionData: {
    model_config?: Session['model_config'];
  } | null;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function previousUtcDayRange(now = new Date()): { day: string; start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - ONE_DAY_MS);
  return { day: start.toISOString().slice(0, 10), start, end };
}

async function countCreatedRows(
  db: TenantScopeAwareDatabase,
  table: typeof tasks | typeof sessions | typeof branches,
  start: Date,
  end: Date
): Promise<number> {
  const row = await select(db, { value: count() })
    .from(table)
    .where(and(gte(table.created_at, start), lt(table.created_at, end)))
    .one();
  return Number(row?.value ?? 0);
}

async function addDistinctCreatedBy(
  db: TenantScopeAwareDatabase,
  table: typeof tasks | typeof sessions | typeof branches,
  start: Date,
  end: Date,
  users: Set<string>
): Promise<void> {
  const rows = await select(db, { createdBy: table.created_by })
    .from(table)
    .where(and(gte(table.created_at, start), lt(table.created_at, end)))
    .groupBy(table.created_by)
    .all();

  for (const row of rows as Array<{ createdBy: string | null }>) {
    if (row.createdBy) users.add(row.createdBy);
  }
}

async function getTaskUsageRows(
  db: TenantScopeAwareDatabase,
  start: Date,
  end: Date
): Promise<TaskUsageRow[]> {
  return (await select(db, {
    taskData: tasks.data,
    agenticTool: sessions.agentic_tool,
    sessionData: sessions.data,
  })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
    .where(and(gte(tasks.created_at, start), lt(tasks.created_at, end)))
    .all()) as TaskUsageRow[];
}

export async function flushOpenSourceTelemetryUsageSummary(
  db: TenantScopeAwareDatabase
): Promise<void> {
  if (!openSourceTelemetryLogger.isEnabled()) return;

  const { day, start, end } = previousUtcDayRange();
  const config = await loadConfig();
  if (config.telemetry?.last_usage_summary_day === day) return;

  const [promptCount, branchCreatedCount, sessionCreatedCount, taskRows] = await Promise.all([
    countCreatedRows(db, tasks, start, end),
    countCreatedRows(db, branches, start, end),
    countCreatedRows(db, sessions, start, end),
    getTaskUsageRows(db, start, end),
  ]);

  const activeUsers = new Set<string>();
  await Promise.all([
    addDistinctCreatedBy(db, tasks, start, end, activeUsers),
    addDistinctCreatedBy(db, sessions, start, end, activeUsers),
    addDistinctCreatedBy(db, branches, start, end, activeUsers),
  ]);

  const taskCountByAgenticTool: Record<string, number> = {};
  const taskCountByProvider: Record<string, number> = {};
  const taskCountByModelFamily: Record<string, number> = {};

  for (const task of taskRows) {
    increment(taskCountByAgenticTool, task.agenticTool ?? 'unknown');
    increment(
      taskCountByProvider,
      normalizeTelemetryProvider(task.sessionData?.model_config?.provider)
    );
    increment(
      taskCountByModelFamily,
      normalizeTelemetryModelFamily(task.taskData?.model ?? task.sessionData?.model_config?.model)
    );
  }

  if (promptCount > 0 || sessionCreatedCount > 0 || branchCreatedCount > 0) {
    openSourceTelemetryLogger.track({
      event: 'usage.daily_summary',
      properties: {
        day,
        period: 'previous_utc_day',
        prompt_count: promptCount,
        active_user_count: activeUsers.size,
        session_created_count: sessionCreatedCount,
        branch_created_count: branchCreatedCount,
        task_count_by_agentic_tool: taskCountByAgenticTool,
        task_count_by_provider: taskCountByProvider,
        task_count_by_model_family: taskCountByModelFamily,
      },
    });
    await openSourceTelemetryLogger.flush();
  }

  config.telemetry = { ...config.telemetry, last_usage_summary_day: day };
  await saveConfig(pruneDefaultOpenSourceTelemetryDestination(config));
}

export interface OpenSourceTelemetryUsageSummaryIntervalOptions {
  /** Tenant used for daemon-global telemetry scans that have no request auth context. */
  tenantId: TenantID | string;
}

export function startOpenSourceTelemetryUsageSummaryInterval(
  db: TenantScopeAwareDatabase,
  options: OpenSourceTelemetryUsageSummaryIntervalOptions
): NodeJS.Timeout {
  // Check hourly, but emit at most once per UTC day. The DB query only runs
  // when the previous day has not yet been reported, keeping steady-state
  // overhead to one config read per hour.
  const run = (): void => {
    runWithTenantDatabaseScope(db, options.tenantId, () =>
      flushOpenSourceTelemetryUsageSummary(db)
    ).catch((error) => {
      console.warn(
        '[telemetry] failed to emit usage summary:',
        error instanceof Error ? error.message : String(error)
      );
    });
  };

  const startupTimer = setTimeout(run, 30_000);
  startupTimer.unref?.();

  const timer = setInterval(run, ONE_HOUR_MS);
  timer.unref?.();
  return timer;
}
