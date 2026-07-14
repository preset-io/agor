// src/types/task.ts
import type { MessageID, SessionID, TaskID } from './id';
import type { MessageSource } from './message';
import type { ReportPath, ReportTemplate } from './report';

export const TaskStatus = {
  QUEUED: 'queued', // Task created but not yet running (waiting for executor to drain queue)
  CREATED: 'created',
  DISPATCHING: 'dispatching', // Daemon persisted launch intent; executor has not connected yet
  RUNNING: 'running',
  STOPPING: 'stopping', // Stop requested, waiting for SDK to halt
  AWAITING_PERMISSION: 'awaiting_permission',
  AWAITING_INPUT: 'awaiting_input', // Legacy / pre-#1177: AskUserQuestion was disallowed at the SDK; new tasks never enter this state, kept for historical rows
  TIMED_OUT: 'timed_out', // Permission/input request timed out, executor exited — user must re-prompt
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped', // User-requested stop (distinct from failed)
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Structured metadata attached to a task. All fields are optional, but the
 * ones that are present are load-bearing — typing them here prevents drift
 * between the daemon (which writes them) and the UI/services that read them.
 *
 * - `is_agor_callback`: marks a task whose prompt was synthesized by the
 *   callback machinery (child session finished → parent gets a system
 *   message). Drives both auth attribution and UI styling.
 * - `source`: where the prompt entered the system. Copied onto the
 *   user-message row so message-level provenance survives the queue → run
 *   transition.
 * - `queued_by_user_id`: who scheduled the task (distinct from
 *   `task.created_by` for callback tasks, where `created_by` is the
 *   callback owner and `queued_by_user_id` is set to the same value but
 *   the field carries semantic intent rather than ownership).
 * - `child_session_id` / `child_task_id`: lineage breadcrumbs for callback
 *   tasks — the child session/task whose completion produced this prompt.
 */
export interface TaskMetadata {
  is_agor_callback?: boolean;
  source?: MessageSource;
  queued_by_user_id?: string;
  child_session_id?: SessionID;
  child_task_id?: TaskID;
  /**
   * Completion callbacks already dispatched for this task, keyed by event +
   * target. The daemon uses this as an idempotency marker so child-session
   * completion notifications are not queued twice if multiple completion
   * paths race.
   */
  callback_dispatches?: Array<{
    event: 'session_completion';
    target_session_id: SessionID;
    queued_task_id?: TaskID;
    dispatched_at: string;
  }>;
  /**
   * Marks a task whose prompt was authored by the daemon (not typed by a
   * human). Used by widget auto-resume so the UI can label the queued
   * prompt appropriately.
   */
  system_authored?: boolean;
  /**
   * For tasks queued by widget resolution, the widget message that fired
   * this prompt. Links the task back to the originating widget for audit.
   */
  widget_id?: MessageID;
}

/**
 * A task reached a terminal state *on its own* (finished or hit an error),
 * as opposed to being user-stopped/timed-out/cancelled. Used e.g. to gate
 * completion notifications that should only fire on natural finishes.
 */
export function isNaturalCompletion(status: TaskStatus): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED;
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);

/** Every terminal executor outcome requires cleanup before releasing its session. */
export const EXECUTOR_FINALIZABLE_TASK_STATUSES = TERMINAL_TASK_STATUSES;

export function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return status !== undefined && TERMINAL_TASK_STATUSES.has(status);
}

/**
 * Task states owned by an active executor turn. These block starting another
 * task in the same session and should be stopped/failed before queue drain can
 * continue. CREATED and QUEUED are intentionally excluded: CREATED is a
 * pre-executor row and QUEUED is waiting for a future turn.
 */
export const EXECUTING_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TaskStatus.DISPATCHING,
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
]);

export type TaskExecutionState = Pick<Task, 'status'>;

export function isTaskExecuting(task: TaskExecutionState): boolean {
  return EXECUTING_TASK_STATUSES.has(task.status);
}

/**
 * Authoritative context-window snapshot captured at task completion.
 *
 * Source depends on the agentic tool:
 * - Claude Code: derived from the Claude Agent SDK `getContextUsage()` response.
 * - Codex: extracted from the Codex CLI's `event_msg/token_count.last_token_usage`
 *   payload — see `extractCodexContextSnapshotFromEvent` in the executor.
 *
 * `percentage` is the value the source tool itself reports/displays for
 * "Context XX% used" (i.e. for Codex it is baseline-adjusted to match the
 * CLI TUI's indicator). Consumers should prefer this over recomputing
 * `totalTokens / maxTokens` so per-tool conventions are respected.
 */
export interface ContextUsageSnapshot {
  totalTokens: number;
  maxTokens: number;
  /** 0–100, integer, ready to display */
  percentage: number;
}

export const PULSE_KIND = {
  EXECUTOR_CONNECTED: 'executor.connected',
  SDK_STARTED: 'sdk.started',
  SDK_FIRST_EVENT: 'sdk.first_event',
  SDK_PROGRESS: 'sdk.progress',
  SDK_UNKNOWN: 'sdk.unknown',
  ASSISTANT_MESSAGE: 'assistant.message',
  ASSISTANT_STREAM: 'assistant.stream',
  THINKING_PROGRESS: 'thinking.progress',
  TOOL_STARTED: 'tool.started',
  TOOL_PROGRESS: 'tool.progress',
  TOOL_FINISHED: 'tool.finished',
  PERMISSION_WAIT_STARTED: 'permission.wait_started',
  PERMISSION_WAIT_ENDED: 'permission.wait_ended',
} as const;

export type PulseKind = (typeof PULSE_KIND)[keyof typeof PULSE_KIND];

export const PULSE_KINDS: readonly PulseKind[] = Object.values(PULSE_KIND);

export interface Pulse {
  kind: PulseKind;
  /** Stable id when available: tool_use_id, call_id, native message id. */
  id?: string;
  /** Privacy-safe label: Bash, Read, Cursor tool_call, etc. */
  label?: string;
}

export interface PulseSnapshot extends Pulse {
  /** Added by the daemon when it accepts a new pulse. */
  at: string;
}

const MAX_PULSE_KIND_LENGTH = 120;
const MAX_PULSE_ID_LENGTH = 160;
const MAX_PULSE_LABEL_LENGTH = 120;
const VALID_PULSE_KINDS = new Set<string>(PULSE_KINDS);

/** Keep executor telemetry bounded and free of provider payloads or other unmodeled data. */
export function sanitizePulse(value: unknown): Pulse | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const pulse = value as Record<string, unknown>;
  const candidateKind = trimPulseString(pulse.kind, MAX_PULSE_KIND_LENGTH);
  const kind =
    candidateKind && VALID_PULSE_KINDS.has(candidateKind)
      ? (candidateKind as PulseKind)
      : PULSE_KIND.SDK_UNKNOWN;
  const id = trimPulseString(pulse.id, MAX_PULSE_ID_LENGTH);
  const label = trimPulseString(pulse.label, MAX_PULSE_LABEL_LENGTH);

  return {
    kind,
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
  };
}

/** Keep generic SDK chatter from replacing semantic assistant/tool progress. */
export function isMeaningfulPulse(pulse: Pulse): boolean {
  return pulse.kind !== PULSE_KIND.SDK_UNKNOWN && pulse.kind !== PULSE_KIND.SDK_PROGRESS;
}

function trimPulseString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export interface ExecutorClaim {
  task_id: string;
  executor_attempt_id: string;
}

export interface ExecutorTelemetryReport extends ExecutorClaim {
  /** Heartbeats and final pulse flushes share one guarded transport method. */
  heartbeat: boolean;
  pulse?: Pulse;
}

export const EXECUTOR_CLEANUP_STATUS = {
  UNRESOLVED: 'unresolved',
  VERIFIED: 'verified',
} as const;

export type ExecutorCleanupStatus =
  (typeof EXECUTOR_CLEANUP_STATUS)[keyof typeof EXECUTOR_CLEANUP_STATUS];

export const EXECUTOR_STATE_PERSISTENCE_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;

export type ExecutorStatePersistenceStatus =
  (typeof EXECUTOR_STATE_PERSISTENCE_STATUS)[keyof typeof EXECUTOR_STATE_PERSISTENCE_STATUS];

export const EXECUTOR_STATE_PERSISTENCE_REQUIREMENT = {
  NOT_REQUIRED: 'not_required',
  REQUIRED: 'required',
} as const;

export type ExecutorStatePersistenceRequirement =
  (typeof EXECUTOR_STATE_PERSISTENCE_REQUIREMENT)[keyof typeof EXECUTOR_STATE_PERSISTENCE_REQUIREMENT];

/** The first terminal owner of an executor attempt. This value is write-once. */
export const EXECUTOR_TERMINAL_CAUSE = {
  EXECUTOR_REPORTED: 'executor_reported',
  UNEXPECTED_EXIT: 'unexpected_exit',
  USER_STOP: 'user_stop',
  DISPATCH_TIMEOUT: 'dispatch_timeout',
  HEARTBEAT_LOST: 'heartbeat_lost',
  PERMISSION_TIMEOUT: 'permission_timeout',
  LAUNCH_FAILED_ABSENT: 'launch_failed_absent',
  LAUNCH_FAILED_UNKNOWN: 'launch_failed_unknown',
  DAEMON_RESTART: 'daemon_restart',
} as const;

export type ExecutorTerminalCause =
  (typeof EXECUTOR_TERMINAL_CAUSE)[keyof typeof EXECUTOR_TERMINAL_CAUSE];
export type ExecutorLeaseTerminalCause =
  | typeof EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT
  | typeof EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST;

export const EXECUTOR_WORKLOAD_KIND = {
  LOCAL: 'local',
  TEMPLATED: 'templated',
} as const;

export type ExecutorWorkloadKind =
  (typeof EXECUTOR_WORKLOAD_KIND)[keyof typeof EXECUTOR_WORKLOAD_KIND];

/** Durable evidence required before an executor-owned turn may release its session. */
export interface ExecutorFinalizationEvidence {
  cleanup_status: ExecutorCleanupStatus;
  state_persistence_status: ExecutorStatePersistenceStatus;
  cleanup_error: string | null;
  state_persistence_error: string | null;
  cleanup_verified_at: string | null;
}

export interface ExecutorWorkloadDescriptor {
  kind: ExecutorWorkloadKind;
  unix_user?: string;
}

export interface ExecutorFinalizationState extends ExecutorFinalizationEvidence {
  workload?: ExecutorWorkloadDescriptor;
  state_persistence_requirement: ExecutorStatePersistenceRequirement;
}

export function createPendingExecutorFinalization(
  workload?: ExecutorWorkloadDescriptor,
  statePersistenceRequirement: ExecutorStatePersistenceRequirement = EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.NOT_REQUIRED
): ExecutorFinalizationState {
  return {
    cleanup_status: EXECUTOR_CLEANUP_STATUS.UNRESOLVED,
    state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING,
    cleanup_error: null,
    state_persistence_error: null,
    cleanup_verified_at: null,
    state_persistence_requirement: statePersistenceRequirement,
    ...(workload ? { workload } : {}),
  };
}

export function isExecutorFinalizationReleasable(
  evidence: Pick<ExecutorFinalizationEvidence, 'cleanup_status' | 'state_persistence_status'>
): boolean {
  return (
    evidence.cleanup_status === EXECUTOR_CLEANUP_STATUS.VERIFIED &&
    (evidence.state_persistence_status === EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED ||
      evidence.state_persistence_status === EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED)
  );
}

export interface Task {
  /** Unique task identifier (UUIDv7) */
  task_id: TaskID;

  /** Session this task belongs to */
  session_id: SessionID;

  /** User ID of the user who created this task */
  created_by: string;

  /** Original user prompt (can be multi-line) */
  full_prompt: string;

  status: TaskStatus;

  /**
   * Queue position when status is QUEUED. Lower values drain first.
   * Undefined for non-queued tasks.
   */
  queue_position?: number;

  /**
   * Structured metadata for the task. Fields here are load-bearing for
   * auth, lineage, and UI styling — see the per-field comments. When a
   * QUEUED task transitions to RUNNING and a user-message row is written,
   * `is_agor_callback` and `source` are copied onto the new message.metadata
   * so the UI styling for callbacks survives the queue → run hop.
   */
  metadata?: TaskMetadata;

  // Message range
  message_range: {
    start_index: number;
    end_index: number;
    start_timestamp: string;
    end_timestamp?: string;
  };

  // Tool usage
  tool_use_count: number;

  // Git state
  git_state: {
    ref_at_start: string; // Branch name at task start (required)
    sha_at_start: string; // SHA at task start (required)
    sha_at_end?: string; // SHA at task end (optional)
    commit_message?: string; // Commit message if task resulted in a commit (optional)
  };

  // Task execution metadata
  duration_ms?: number; // Total execution time from SDK
  agent_session_id?: string; // SDK's internal session ID for debugging

  /**
   * Human-readable error message populated when the task transitions to the
   * `failed` state. Captures the reason so UI and logs can surface a clear
   * cause instead of silently leaving the session idle with a ghost task.
   */
  error_message?: string;

  // Model (resolved model ID used for this task, e.g., "claude-sonnet-4-5-20250929")
  model?: string;

  // Raw SDK response - single source of truth for token accounting
  // Stores the unmutated SDK event (turn.completed for Codex, Finished for Gemini, etc.)
  // Access token usage, context window, costs, etc. via normalizers
  // Optional to support legacy tasks that don't have this field
  raw_sdk_response?: unknown; // Raw SDK response stored as JSON

  // Normalized SDK response - computed from raw_sdk_response by executor
  // Stored here so UI doesn't need SDK-specific normalization logic
  // Will be empty for legacy tasks (pre-normalization)
  normalized_sdk_response?: {
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens?: number; // Claude-specific: prompt caching reads
      cacheCreationTokens?: number; // Claude-specific: prompt caching writes
    };
    contextWindowLimit?: number; // Model's max context window (e.g., 200k for Claude)
    costUsd?: number; // Estimated cost in USD (if pricing available)
    primaryModel?: string; // Resolved model used for the task
    durationMs?: number; // Total execution duration from SDK, when available
    /** Authoritative SDK/protocol context-window snapshot when available */
    contextUsageSnapshot?: ContextUsageSnapshot;
  };

  // Current context-window occupancy in tokens at the end of this task.
  //
  // Source precedence (set by base-executor):
  // 1. `normalized_sdk_response.contextUsageSnapshot.totalTokens` when the
  //    tool surfaced an authoritative snapshot (Claude SDK getContextUsage,
  //    Codex CLI event_msg/token_count last_token_usage). This is the common
  //    case and is what UI consumers should rely on.
  // 2. Otherwise the tool's `computeContextWindow()` fallback (per-tool
  //    heuristic — see tool.interface.ts).
  //
  // For display percentages, prefer `contextUsageSnapshot.percentage` over
  // recomputing here — Codex applies a baseline subtraction that does NOT
  // equal raw `computed_context_window / contextWindowLimit`.
  computed_context_window?: number;

  // Report (auto-generated after task completion)
  report?: {
    /**
     * File path relative to context/reports/
     * Format: "<session-id>/<task-id>.md"
     */
    path: ReportPath;
    template: ReportTemplate;
    generated_at: string;
  };

  /** Latest meaningful SDK/tool pulse accepted and timestamped by the daemon. */
  latest_executor_pulse?: PulseSnapshot;

  // Permission request (when task is awaiting user approval)
  permission_request?: {
    request_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id?: string;
    requested_at: string;
    // Optional: Track who approved (for audit trail)
    approved_by?: string; // userId
    approved_at?: string;
  };

  /** MD5 of the SDK session file at task completion (only populated when stateless_fs_mode is enabled) */
  session_md5?: string;

  created_at: string;
  started_at?: string; // When task execution was dispatched (UTC ISO string)
  /** Server timestamp recorded when the authenticated executor claims the task. */
  executor_connected_at?: string; // UTC ISO string
  /** Daemon-minted launch attempt that owns this task's executor claim. */
  executor_attempt_id?: string;
  /** Durable, write-once reason this executor attempt became terminal. */
  executor_terminal_cause?: ExecutorTerminalCause;
  /** Durable cleanup/state evidence for the owning executor attempt. */
  executor_finalization?: ExecutorFinalizationState;
  /** Latest heartbeat emitted by the executor while this task is active. */
  last_executor_heartbeat_at?: string; // UTC ISO string
  completed_at?: string; // When task reached terminal status (UTC ISO string)
}

/** Add the canonical timestamps for any task's first terminal transition. */
export function normalizeTerminalTaskPatch(
  current: Task,
  patch: Partial<Task> & { status: TaskStatus }
): Partial<Task> & { status: TaskStatus; completed_at: string } {
  const completedAt = patch.completed_at ?? new Date().toISOString();
  const startTime =
    current.started_at ?? current.message_range?.start_timestamp ?? current.created_at;
  const elapsed = Date.parse(completedAt) - Date.parse(startTime);
  const currentRange = current.message_range;
  const shouldCloseRange =
    currentRange &&
    (!currentRange.end_timestamp || currentRange.end_timestamp === currentRange.start_timestamp);

  return {
    ...patch,
    completed_at: completedAt,
    duration_ms: patch.duration_ms ?? (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0),
    ...(shouldCloseRange
      ? {
          message_range: {
            ...currentRange,
            ...patch.message_range,
            end_timestamp: patch.message_range?.end_timestamp ?? completedAt,
          },
        }
      : {}),
  };
}
