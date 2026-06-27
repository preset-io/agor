import {
  normalizeTelemetryModelFamily,
  normalizeTelemetryProvider,
  openSourceTelemetryLogger,
} from '@agor/core/telemetry';
import type { Branch, Session, Task } from '@agor/core/types';

interface UsageCounters {
  promptCount: number;
  activeUsers: Set<string>;
  sessionCreatedCount: number;
  branchCreatedCount: number;
  taskCountByAgenticTool: Record<string, number>;
  taskCountByProvider: Record<string, number>;
  taskCountByModelFamily: Record<string, number>;
}

function emptyCounters(): UsageCounters {
  return {
    promptCount: 0,
    activeUsers: new Set<string>(),
    sessionCreatedCount: 0,
    branchCreatedCount: 0,
    taskCountByAgenticTool: {},
    taskCountByProvider: {},
    taskCountByModelFamily: {},
  };
}

let counters = emptyCounters();

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function recordOpenSourceTelemetryTaskCreated(task: Task): void {
  counters.promptCount += 1;
  if (task.created_by) counters.activeUsers.add(task.created_by);
}

export function recordOpenSourceTelemetrySessionCreated(session: Session): void {
  counters.sessionCreatedCount += 1;
  if (session.created_by) counters.activeUsers.add(session.created_by);
  increment(counters.taskCountByAgenticTool, session.agentic_tool ?? 'unknown');
  increment(
    counters.taskCountByProvider,
    normalizeTelemetryProvider(session.model_config?.provider)
  );
  increment(
    counters.taskCountByModelFamily,
    normalizeTelemetryModelFamily(session.model_config?.model)
  );
}

export function recordOpenSourceTelemetryBranchCreated(branch: Branch): void {
  counters.branchCreatedCount += 1;
  if (branch.created_by) counters.activeUsers.add(branch.created_by);
}

export function flushOpenSourceTelemetryUsageSummary(): void {
  if (!openSourceTelemetryLogger.isEnabled()) return;
  if (
    counters.promptCount === 0 &&
    counters.sessionCreatedCount === 0 &&
    counters.branchCreatedCount === 0
  ) {
    return;
  }

  openSourceTelemetryLogger.track({
    event: 'usage.daily_summary',
    properties: {
      prompt_count: counters.promptCount,
      active_user_count: counters.activeUsers.size,
      session_created_count: counters.sessionCreatedCount,
      branch_created_count: counters.branchCreatedCount,
      task_count_by_agentic_tool: counters.taskCountByAgenticTool,
      task_count_by_provider: counters.taskCountByProvider,
      task_count_by_model_family: counters.taskCountByModelFamily,
    },
  });
  counters = emptyCounters();
}

export function startOpenSourceTelemetryUsageSummaryInterval(): NodeJS.Timeout {
  const timer = setInterval(
    () => {
      flushOpenSourceTelemetryUsageSummary();
      void openSourceTelemetryLogger.flush();
    },
    24 * 60 * 60 * 1000
  );
  timer.unref?.();
  return timer;
}
