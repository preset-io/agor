import { shortId, type Task, type User } from '@agor-live/client';
import { formatAbsoluteTime, formatRelativeTimeSafe } from '../../utils/time';
import type { CompactNoticeDetail } from '../CompactNotice';

const DEFAULT_STOP_TEXT = /^\s*(stopped by user\.?)?\s*$/i;

export interface TurnOutcomeDetailsContext {
  agenticTool?: string;
  userById?: Map<string, User>;
}

/** "45s", "3m 29s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * Technical facts already on the task, for the Details panel. `hasSignal` is
 * true when something explains this outcome beyond routine run metadata.
 */
export function turnOutcomeDetails(
  task: Task,
  { agenticTool, userById }: TurnOutcomeDetailsContext = {}
): { rows: CompactNoticeDetail[]; hasSignal: boolean } {
  const rows: CompactNoticeDetail[] = [];
  const error = task.error_message?.trim();
  if (error && !DEFAULT_STOP_TEXT.test(error)) {
    rows.push({ label: 'Error', value: error, code: true });
  }

  const causes = [...new Set([task.sdk_failure?.reason, task.termination_request?.cause])].filter(
    (cause): cause is NonNullable<typeof cause> => !!cause
  );
  if (causes.length) rows.push({ label: 'Cause', value: causes.join(' · '), code: true });
  if (task.sdk_failure?.termination) {
    rows.push({ label: 'Termination', value: task.sdk_failure.termination, code: true });
  }

  const request = task.termination_request;
  const requesterId = request?.requested_by_user_id;
  if (requesterId || request?.requested_via) {
    const name = requesterId
      ? userById?.get(requesterId)?.name?.trim() || shortId(requesterId)
      : undefined;
    rows.push({
      label: 'Stopped by',
      value: [name, request?.requested_via].filter(Boolean).join(' · '),
    });
  }
  const hasSignal = rows.length > 0;

  const agent = [agenticTool, task.model].filter(Boolean).join(' · ');
  if (agent) rows.push({ label: 'Agent', value: agent, code: true });

  const pulse = task.latest_executor_pulse;
  if (pulse) {
    const when = formatRelativeTimeSafe(pulse.observed_at);
    rows.push({
      label: 'Last activity',
      value: [`${pulse.kind}${pulse.detail ? `: ${pulse.detail}` : ''}`, when]
        .filter(Boolean)
        .join(' · '),
      code: true,
    });
  }

  const startedAt = task.started_at ?? task.created_at;
  const endedAt = task.completed_at;
  const durationMs =
    task.duration_ms ??
    (startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined);
  const timing = [
    startedAt && `started ${formatAbsoluteTime(startedAt)}`,
    endedAt && `ended ${formatAbsoluteTime(endedAt)}`,
    durationMs !== undefined && Number.isFinite(durationMs) && formatElapsed(durationMs),
  ].filter(Boolean);
  if (timing.length) rows.push({ label: 'Timing', value: timing.join(' · ') });

  if (typeof task.recorded_tool_count === 'number') {
    rows.push({ label: 'Tool calls', value: String(task.recorded_tool_count) });
  }
  rows.push({ label: 'Task', value: task.task_id, code: true });
  return { rows, hasSignal };
}
