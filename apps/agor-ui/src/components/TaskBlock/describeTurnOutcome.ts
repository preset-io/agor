import {
  CODEX_LIFECYCLE_MESSAGES,
  DAEMON_RESTART_RELEASED_MESSAGE,
  failureMessageBase,
  isConnectionLossMessage,
  isExecutorOutOfMemoryMessage,
  isMissingCredentialMessage,
  isTerminalTaskStatus,
  LEGACY_SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  parsePermissionTimeoutMs,
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
} from '@agor/core/types';
import { type Task, TaskStatus } from '@agor-live/client';
import type { CompactNoticeType } from '../CompactNotice';

export type TurnOutcomeCause =
  | 'stop_unconfirmed'
  | 'reopened_unconfirmed'
  | 'interrupted'
  | 'restart_unconfirmed'
  | 'stopping'
  | 'waiting_to_start'
  | 'working_with_problem'
  | 'launch_refused'
  | 'restart'
  | 'stopped'
  | 'access_changed'
  | 'approval_timeout'
  | 'not_connected'
  | 'never_started'
  | 'out_of_memory'
  | 'lost_connection'
  | 'stalled'
  | 'usage_limit'
  | 'provider_rejected'
  | 'stopped_early'
  | 'unknown';

export interface TurnOutcomeCopy {
  cause: TurnOutcomeCause;
  type: CompactNoticeType;
  message: string;
  action?: 'resume' | 'retry' | 'settings';
  /** Plain-language context shown above the raw error inside Details. */
  detailsLead?: string;
  /** The message names when the usage limit resets, so the rate-limit card need not. */
  showsResetTime?: true;
}

export interface TurnOutcomeContext {
  /** Tool activity is visible in the loaded transcript. */
  sawTools?: boolean;
  agentName?: string;
  /** The transcript shows the Connect panel for this turn's missing credential. */
  missingCredential?: boolean;
  /** This turn was rejected by a provider usage limit; `resetsAt` is unix seconds. */
  rateLimit?: { resetsAt?: number };
  /** Agor attached a restart notice to this turn; it can also land on a turn that ended earlier. */
  restarted?: boolean;
  /** Who asked for the stop, when a person in the UI did. */
  stoppedBy?: 'you' | { name: string };
  /** The viewer; only their own typed prompt may be replayed as Try again. */
  currentUserId?: string;
  now?: Date;
}

export const EDITS_KEPT = 'Any edits are kept.';
export const NO_FILES_CHANGED = 'No files changed.';
export const APPROVAL_TIMEOUT_MESSAGE = 'The agent stopped waiting for approval.';

const LOST_CONNECTION = new Set([
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  CODEX_LIFECYCLE_MESSAGES.stream_interrupted,
  CODEX_LIFECYCLE_MESSAGES.stream_ended_without_completion,
]);
const STOPPED_EARLY = new Set([
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  LEGACY_SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  CODEX_LIFECYCLE_MESSAGES.completed_without_response,
]);

/** "10 minutes", "2 hours", "45 seconds": the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const [value, unit] =
    seconds >= 3600 && seconds % 3600 === 0
      ? [seconds / 3600, 'hour']
      : seconds >= 60 && seconds % 60 === 0
        ? [seconds / 60, 'minute']
        : [seconds, 'second'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "3:00 PM" today, "Mon 3:00 PM" within the week, "Oct 20, 3:00 PM" later; undefined once past. */
function formatReset(resetsAt: number, now: Date): string | undefined {
  const at = new Date(resetsAt * 1000);
  if (at.getTime() <= now.getTime()) return undefined;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  if (at.getTime() - now.getTime() < 6 * DAY_MS) {
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A prompt the viewer typed themselves, so replaying it as them sends nothing new. */
function isViewersOwnPrompt(task: Task, currentUserId: string | undefined): boolean {
  const metadata = task.metadata;
  return (
    !!currentUserId &&
    task.created_by === currentUserId &&
    !!task.full_prompt?.trim() &&
    metadata?.source === 'agor' &&
    !metadata.is_agor_callback &&
    !metadata.system_authored
  );
}

/** Friendly one-line outcome for a finished or stopping turn; null when nothing needs saying. */
export function describeTurnOutcome(
  task: Task,
  {
    sawTools = false,
    agentName,
    missingCredential = false,
    rateLimit,
    restarted = false,
    stoppedBy,
    currentUserId,
    now = new Date(),
  }: TurnOutcomeContext = {}
): TurnOutcomeCopy | null {
  const { status, sdk_failure: failure, termination_request: request } = task;
  const error = failureMessageBase(task.error_message ?? '');
  const outcomeStatuses: TaskStatus[] = [
    TaskStatus.STOPPING,
    TaskStatus.STOPPED,
    TaskStatus.FAILED,
    TaskStatus.TIMED_OUT,
  ];
  if (!outcomeStatuses.includes(status) && !error) return null;
  const reason = failure?.reason;
  const cause = request?.cause;
  const exited = reason === 'heartbeat_lost' || cause === 'heartbeat_lost';
  const lostConnection = exited || LOST_CONNECTION.has(error) || isConnectionLossMessage(error);
  // A restart notice explains only a run that died with the connection; any other cause stands.
  const wasRestart =
    error === DAEMON_RESTART_RELEASED_MESSAGE ||
    (restarted &&
      status === TaskStatus.FAILED &&
      (!cause || cause === 'heartbeat_lost') &&
      lostConnection);

  if (failure?.termination === 'unverified') {
    return wasRestart
      ? {
          cause: 'restart_unconfirmed',
          type: 'warning',
          message: 'Agor restarted. The agent may still be editing files.',
        }
      : {
          type: 'warning',
          cause: status === TaskStatus.FAILED ? 'reopened_unconfirmed' : 'stop_unconfirmed',
          message:
            status === TaskStatus.FAILED
              ? 'Session reopened without confirmed cleanup. The previous work may still change files.'
              : 'Cleanup needs attention. The previous work may still change files.',
          detailsLead:
            status === TaskStatus.FAILED
              ? 'Reopening did not stop the previous work. Messages already received are saved.'
              : 'Use Retry cleanup before continuing. A branch owner or administrator can choose Reopen anyway, but that does not stop the previous work. Messages already received are saved.',
        };
  }
  if (status === TaskStatus.STOPPING) {
    const message =
      cause === 'heartbeat_lost'
        ? 'Connection interrupted — recovering…'
        : cause === 'executor_interrupted'
          ? 'Work interrupted — recovering…'
          : cause === 'sdk_health_failure'
            ? 'Agent stopped responding — recovering…'
            : cause === 'authorization_revoked'
              ? 'Access changed — stopping work…'
              : 'Stopping the agent…';
    return {
      cause: 'stopping',
      type: 'info',
      message,
      detailsLead:
        'Agor is checking that the previous work has stopped. You do not need to stop it again. Queued prompts will wait until recovery finishes.',
    };
  }
  if (!isTerminalTaskStatus(status)) {
    return status === TaskStatus.DISPATCHING && !task.executor_connected_at
      ? { cause: 'waiting_to_start', type: 'info', message: 'Waiting for the agent to start…' }
      : {
          cause: 'working_with_problem',
          type: 'info',
          message: 'The agent hit a problem but is still working.',
        };
  }
  if (status === TaskStatus.COMPLETED) return null;
  // Refused before anything was created, with no connect time or tools: it
  // must win over never_started. Retrying now would usually be refused again.
  if (reason === 'launch_refused' || cause === 'launch_refused') {
    return {
      cause: 'launch_refused',
      type: 'warning',
      message: `Your team has reached its limit of work running at once, so the agent didn't start. ${NO_FILES_CHANGED}`,
    };
  }
  const provenNothing = !sawTools && task.recorded_tool_count === 0;
  const work = provenNothing ? NO_FILES_CHANGED : EDITS_KEPT;
  // The cleanup command reported why the executor died; that beats restart, interruption and
  // every heuristic below. Only an unverified termination or a user stop says more.
  if (
    cause !== 'user_stop' &&
    status !== TaskStatus.STOPPED &&
    isExecutorOutOfMemoryMessage(error)
  ) {
    return { cause: 'out_of_memory', type: 'error', message: `${error} ${work}`, action: 'resume' };
  }
  if (wasRestart) {
    return {
      cause: 'restart',
      type: 'warning',
      message: `Agor restarted during this run. ${work}`,
      action: 'resume',
    };
  }
  if (cause === 'user_stop' || status === TaskStatus.STOPPED) {
    const who =
      stoppedBy === 'you'
        ? 'You stopped the agent.'
        : stoppedBy
          ? `${stoppedBy.name} stopped the agent.`
          : 'The agent was stopped.';
    return { cause: 'stopped', type: 'neutral', message: `${who} ${EDITS_KEPT}` };
  }
  if (cause === 'authorization_revoked') {
    return {
      cause: 'access_changed',
      type: 'warning',
      message: 'Agor stopped the agent after an access change.',
    };
  }
  if (status === TaskStatus.TIMED_OUT) {
    const timeoutMs = parsePermissionTimeoutMs(error);
    return {
      cause: 'approval_timeout',
      type: 'warning',
      message: APPROVAL_TIMEOUT_MESSAGE,
      detailsLead: `Approval requests expire after ${timeoutMs ? formatDuration(timeoutMs) : 'a while'}.`,
      action: 'resume',
    };
  }

  if (cause === 'executor_interrupted' || reason === 'executor_interrupted') {
    return {
      cause: 'interrupted',
      type: 'warning',
      message: `The agent was interrupted before it could finish. ${EDITS_KEPT}`,
      action: 'resume',
    };
  }
  if (missingCredential) return null;
  if (isMissingCredentialMessage(error)) {
    return {
      cause: 'not_connected',
      type: 'warning',
      message: `${agentName ?? 'Your agent'} isn't connected, so nothing ran.`,
      action: 'settings',
    };
  }
  const startupFailed =
    reason === 'startup_timeout' ||
    cause === 'startup_timeout' ||
    error === CODEX_LIFECYCLE_MESSAGES.stream_start_failed;
  // A missing connect time proves nothing on legacy rows: trust it only beside a field recorded with it.
  const neverConnected =
    !task.executor_connected_at &&
    !sawTools &&
    !task.recorded_tool_count &&
    (exited || task.recorded_tool_count === 0);
  if (startupFailed || neverConnected) {
    return {
      cause: 'never_started',
      type: 'error',
      message: `The agent couldn't start. ${NO_FILES_CHANGED}`,
      action: isViewersOwnPrompt(task, currentUserId) ? 'retry' : 'resume',
    };
  }
  if (lostConnection) {
    return {
      cause: 'lost_connection',
      type: 'error',
      message: `Lost connection to the agent. ${work}`,
      action: 'resume',
    };
  }
  if (cause === 'sdk_health_failure') {
    return {
      cause: 'stalled',
      type: 'error',
      message: `The agent stopped responding. ${work}`,
      action: 'resume',
    };
  }
  if (rateLimit) {
    const limit = agentName ? `${agentName} usage limit reached.` : 'Usage limit reached.';
    const reset = rateLimit.resetsAt ? formatReset(rateLimit.resetsAt, now) : undefined;
    if (reset) {
      return {
        cause: 'usage_limit',
        type: 'warning',
        message: `${limit} Try again after ${reset}.`,
        showsResetTime: true,
      };
    }
    // A reset time already behind us means the limit has lifted, so the run can continue.
    return rateLimit.resetsAt
      ? { cause: 'usage_limit', type: 'warning', message: limit, action: 'resume' }
      : { cause: 'usage_limit', type: 'warning', message: `${limit} Try again later.` };
  }
  if (error === CODEX_LIFECYCLE_MESSAGES.turn_failed) {
    return {
      cause: 'provider_rejected',
      type: 'error',
      message: `${agentName ?? 'The agent'} couldn't finish this run. ${work}`,
      action: 'resume',
    };
  }
  if (STOPPED_EARLY.has(error)) {
    return {
      cause: 'stopped_early',
      type: 'error',
      message: `The agent stopped early. ${work}`,
      action: 'resume',
    };
  }
  return {
    cause: 'unknown',
    type: 'error',
    message: `The agent hit a problem. ${work}`,
    action: 'resume',
  };
}
