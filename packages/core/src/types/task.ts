// src/types/task.ts
import type { SessionID, TaskID } from './id';
import type { ReportPath, ReportTemplate } from './report';

export const TaskStatus = {
  CREATED: 'created',
  RUNNING: 'running',
  STOPPING: 'stopping', // Stop requested, waiting for SDK to halt
  AWAITING_PERMISSION: 'awaiting_permission',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped', // User-requested stop (distinct from failed)
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface Task {
  /** Unique task identifier (UUIDv7) */
  task_id: TaskID;

  /** Session this task belongs to */
  session_id: SessionID;

  /** User ID of the user who created this task */
  created_by: string;

  /** Original user prompt (can be multi-line) */
  full_prompt: string;

  /** Optional: LLM-generated short summary */
  description?: string;

  status: TaskStatus;

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

  // Token usage and cost tracking
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number; // Claude-specific: prompt caching reads
    cache_creation_tokens?: number; // Claude-specific: prompt caching writes
    estimated_cost_usd?: number; // Calculated cost based on model pricing
  };

  // Task execution metadata
  duration_ms?: number; // Total execution time from SDK
  agent_session_id?: string; // SDK's internal session ID for debugging
  context_window?: number; // Context window size (total input + output tokens in window)
  context_window_limit?: number; // Maximum context window size for the model(s) used

  // Model (resolved model ID used for this task, e.g., "claude-sonnet-4-5-20250929")
  model?: string;

  // Per-model usage breakdown (for multi-model sessions like Claude Code)
  // Maps model ID to usage stats including context window per model
  model_usage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      contextWindow: number; // Context window limit for this specific model
    }
  >;

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

  created_at: string;
  started_at?: string; // When task status changed to RUNNING (UTC ISO string)
  completed_at?: string; // When task reached terminal status (UTC ISO string)
}
