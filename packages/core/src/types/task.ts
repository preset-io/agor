// src/types/task.ts
import type { SessionID, TaskID } from './id';
import type { MessageSource } from './message';
import type { ReportPath, ReportTemplate } from './report';

export const TaskStatus = {
  QUEUED: 'queued', // Task created but not yet running (waiting for executor to drain queue)
  CREATED: 'created',
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
}

/**
 * A task reached a terminal state *on its own* (finished or hit an error),
 * as opposed to being user-stopped/timed-out/cancelled. Used e.g. to gate
 * completion notifications that should only fire on natural finishes.
 */
export function isNaturalCompletion(status: TaskStatus): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.FAILED;
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
    contextUsageSnapshot?: {
      totalTokens: number;
      maxTokens: number;
      percentage: number;
    }; // Authoritative SDK context snapshot when available
  };

  // Computed context window - cumulative token usage for this session
  // Calculated by tool.computeContextWindow() and stored for efficient access
  // For Claude Code: sum of input+output tokens from all tasks since last compaction
  // For Codex/Gemini: may use latest task's SDK-reported cumulative value
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
  started_at?: string; // When task status changed to RUNNING (UTC ISO string)
  completed_at?: string; // When task reached terminal status (UTC ISO string)
}
