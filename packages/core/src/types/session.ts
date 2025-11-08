// src/types/session.ts

import type {
  AgenticToolName,
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
} from './agentic-tool';
import type { ContextFilePath } from './context';
import type { SessionID, TaskID, WorktreeID } from './id';

export const SessionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  AWAITING_PERMISSION: 'awaiting_permission',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * Permission mode controls how agentic tools handle execution approvals
 *
 * Claude Code modes (Claude Agent SDK):
 * - default: Prompt for each tool use (most restrictive)
 * - acceptEdits: Auto-accept file edits, ask for other tools (recommended)
 * - bypassPermissions: Allow all operations without prompting
 * - plan: Plan mode (generate plan without executing)
 *
 * Codex modes (OpenAI Codex SDK):
 * - ask: Require approval for every tool use (read-only/suggest mode)
 * - auto: Auto-approve safe operations, ask for dangerous ones (auto-edit mode)
 * - on-failure: Auto-approve all, ask only when commands fail
 * - allow-all: Auto-approve all operations (full-auto mode)
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'ask'
  | 'auto'
  | 'on-failure'
  | 'allow-all';

// Re-export permission types from agentic-tool for convenience
export type {
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
};

/**
 * Get the default permission mode for a given agentic tool
 *
 * Each agentic tool has different permission mode capabilities and recommended defaults:
 * - Claude Code: 'acceptEdits' (auto-accept file edits, prompt for other tools)
 * - Cursor: 'acceptEdits' (same as Claude Code)
 * - Codex: 'auto' (auto-approve safe operations, ask for dangerous ones)
 * - Gemini: 'acceptEdits' (same as Claude Code)
 * - OpenCode: 'acceptEdits' (auto-approve via server SDK settings)
 */
export function getDefaultPermissionMode(agenticTool: AgenticToolName): PermissionMode {
  switch (agenticTool) {
    case 'codex':
      return 'auto';
    default:
      return 'acceptEdits';
  }
}

export interface Session {
  /** Unique session identifier (UUIDv7) */
  session_id: SessionID;

  /** Which agentic coding tool is running this session (Claude Code, Codex, Gemini) */
  agentic_tool: AgenticToolName;
  /** Agentic tool/CLI version */
  agentic_tool_version?: string;
  /** SDK session ID for maintaining conversation history (Claude Agent SDK, Codex SDK, etc.) */
  sdk_session_id?: string;
  /** MCP authentication token for Agor self-access */
  mcp_token?: string;
  status: SessionStatus;
  created_at: string;
  last_updated: string;

  /** User ID of the user who created this session */
  created_by: string;

  /** Worktree ID - all sessions must be associated with an Agor-managed worktree */
  worktree_id: WorktreeID;

  // Git state
  git_state: {
    ref: string;
    base_sha: string;
    current_sha: string;
  };

  // Context (context file paths relative to context/)
  contextFiles: ContextFilePath[];

  // Genealogy
  genealogy: {
    /** Session this was forked from (sibling relationship) */
    forked_from_session_id?: SessionID;
    /** Task where fork occurred */
    fork_point_task_id?: TaskID;
    /** Message index where fork occurred (parent's message_count at fork time) */
    fork_point_message_index?: number;
    /** Parent session that spawned this one (child relationship) */
    parent_session_id?: SessionID;
    /** Task where spawn occurred */
    spawn_point_task_id?: TaskID;
    /** Message index where spawn occurred (parent's message_count at spawn time) */
    spawn_point_message_index?: number;
    /** Child sessions spawned from this session */
    children: SessionID[];
  };

  // Tasks
  /** Task IDs in this session */
  tasks: TaskID[];
  message_count: number;

  // UI metadata
  /** Session title (user-provided or auto-generated) */
  title?: string;
  /** Session description (legacy field, may contain first prompt) */
  description?: string;

  // Permission config (session-level tool approvals)
  permission_config?: {
    allowedTools?: string[];
    /** Permission mode for agent tool execution (Claude/Gemini unified mode) */
    mode?: PermissionMode;
    /** Codex-specific dual permission config (sandboxMode + approvalPolicy + networkAccess) */
    codex?: {
      /** Sandbox mode controls WHERE Codex can write (filesystem boundaries) */
      sandboxMode: CodexSandboxMode;
      /** Approval policy controls WHETHER Codex asks before executing */
      approvalPolicy: CodexApprovalPolicy;
      /** Network access controls whether outbound HTTP/HTTPS requests are allowed (workspace-write only) */
      networkAccess?: boolean;
    };
  };

  // Model configuration (session-level model selection)
  model_config?: {
    /** Model selection mode: alias (e.g., 'claude-sonnet-4-5-latest') or exact (e.g., 'claude-sonnet-4-5-20250929') */
    mode: 'alias' | 'exact';
    /** Model identifier (alias or exact ID) */
    model: string;
    /** When this config was last updated */
    updated_at: string;
    /** Optional user notes about why this model was selected */
    notes?: string;
    /**
     * Thinking mode controls extended thinking token allocation
     * - auto: Auto-detect keywords in prompts (matches Claude Code CLI behavior)
     * - manual: Use explicit token budget set by user
     * - off: Disable thinking (no token budget)
     */
    thinkingMode?: 'auto' | 'manual' | 'off';
    /** Manual thinking token budget (used when thinkingMode='manual') */
    manualThinkingTokens?: number;
    /**
     * Provider ID for OpenCode sessions (e.g., 'openai', 'anthropic', 'opencode')
     * Used in combination with model to specify which provider's API to use
     * Only applicable when agentic_tool='opencode'
     */
    provider?: string;
  };

  // Custom context for Handlebars templates
  /**
   * User-defined JSON context for Handlebars templates in zone triggers
   * Example: { "teamName": "Backend", "sprintNumber": 42 }
   * Access in templates: {{ session.context.teamName }}
   */
  custom_context?: Record<string, unknown> & {
    /**
     * Scheduled run metadata (populated by scheduler)
     *
     * Present only if this session was created by the scheduler.
     * Contains execution details and config snapshot at run time.
     */
    scheduled_run?: ScheduledRunMetadata;
  };

  // ===== Context Window Tracking =====

  /**
   * Current context window usage (cumulative tokens in context)
   *
   * Calculated as: input_tokens + cache_read_tokens + cache_creation_tokens
   * from the most recent task with usage data.
   *
   * Based on algorithm from: https://codelynx.dev/posts/calculate-claude-code-context
   *
   * Note: Each API turn returns cumulative totals, so we only need the latest task's usage.
   * We do NOT sum across tasks (that would double-count cached content).
   */
  current_context_usage?: number;

  /**
   * Context window limit for this session's model
   *
   * Examples:
   * - Claude Sonnet: 200,000 tokens
   * - Claude Opus: 200,000 tokens
   * - Extended context models: varies
   */
  context_window_limit?: number;

  /**
   * Timestamp when context was last updated (ISO 8601)
   */
  last_context_update_at?: string;

  // ===== Scheduler Tracking =====

  /**
   * Authoritative run ID for scheduled sessions (Unix timestamp in ms)
   *
   * Stores the exact scheduled time (rounded to minute), NOT when session was created.
   * Used for deduplication and retention cleanup.
   *
   * Example: Midnight run scheduled for 2025-11-03 00:00:00 UTC
   * Even if triggered at 00:00:32, we store 00:00:00 (1730592000000)
   *
   * This becomes the unique run identifier to prevent duplicate scheduling.
   */
  scheduled_run_at?: number;

  /**
   * Whether this session was created by the scheduler
   *
   * Materialized for UI filtering (show clock icon) and analytics.
   * True = created by scheduler, False = created manually by user
   */
  scheduled_from_worktree: boolean;
}

/**
 * Metadata for sessions created by the scheduler
 *
 * Stored in session.custom_context.scheduled_run
 */
export interface ScheduledRunMetadata {
  /**
   * Rendered prompt after Handlebars template substitution
   *
   * Example:
   * Template: "Check PR {{worktree.pull_request_url}}"
   * Rendered: "Check PR https://github.com/org/repo/pull/42"
   */
  rendered_prompt: string;

  /**
   * Run number for this schedule (1st, 2nd, 3rd, ...)
   *
   * Increments with each run. Useful for tracking execution history.
   */
  run_index: number;

  /**
   * Snapshot of schedule config at execution time
   *
   * Preserves configuration even if schedule is later modified or deleted.
   * Useful for debugging and understanding past runs.
   */
  schedule_config_snapshot?: {
    /** Cron expression that triggered this run */
    cron: string;
    /** Timezone for cron evaluation */
    timezone: string;
    /** Retention policy at run time */
    retention: number;
  };
}
