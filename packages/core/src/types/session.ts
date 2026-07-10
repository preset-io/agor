// src/types/session.ts

/**
 * Effort level controls how much reasoning Claude applies.
 * Maps to Claude API's output_config.effort and the Claude Code CLI's --effort flag.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

import type {
  AgenticToolName,
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  CursorPermissionMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
} from './agentic-tool';
import type { ContextFilePath } from './context';
import type { BoardID, BranchID, SessionID, SessionRelationshipID, TaskID, UserID } from './id';
import type { ScheduleID } from './schedule';

export const SessionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping', // Stop requested, waiting for task to stop
  AWAITING_PERMISSION: 'awaiting_permission',
  AWAITING_INPUT: 'awaiting_input', // Legacy / pre-#1177: AskUserQuestion was disallowed at the SDK; new sessions never enter this state, kept for historical rows
  TIMED_OUT: 'timed_out', // Permission/input request timed out, executor exited — user must re-prompt
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * Permission mode controls how agentic tools handle execution approvals
 *
 * This is a union of all native SDK permission modes. Each agent uses its own
 * subset - no mapping/translation needed at the executor level.
 *
 * Claude Code modes (Claude Agent SDK):
 * - default: Prompt for each tool use (most restrictive)
 * - acceptEdits: Auto-accept file edits, ask for other tools (recommended)
 * - bypassPermissions: Allow all operations without prompting
 * - plan: Plan mode (generate plan without executing)
 * - auto: Model classifier approves/denies prompts; unresolved ones fall through to Agor's UI
 * - dontAsk: Legacy mode for backward compatibility
 *
 * Gemini modes (Gemini CLI SDK - ApprovalMode):
 * - default: Prompt for each tool use (ApprovalMode.DEFAULT)
 * - autoEdit: Auto-approve file edits only (ApprovalMode.AUTO_EDIT)
 * - yolo: Auto-approve all operations (ApprovalMode.YOLO)
 *
 * Codex modes (OpenAI Codex SDK):
 * - ask: Require approval for every tool use (read-only/suggest mode)
 * - auto: Auto-approve safe operations, ask for dangerous ones (auto-edit mode)
 * - on-failure: Auto-approve all, ask only when commands fail
 * - allow-all: Auto-approve all operations (full-auto mode)
 */
export type PermissionMode =
  // Claude Code native modes
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  // Gemini native modes
  | 'autoEdit'
  | 'yolo'
  // Codex native modes
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
  CursorPermissionMode,
  GeminiPermissionMode,
  OpenCodePermissionMode,
};

/**
 * Get the default permission mode for a given agentic tool
 *
 * Per tool:
 * - Claude Code: 'auto' — the SDK's model classifier approves/denies each
 *   permission prompt; anything it doesn't confidently auto-resolve still
 *   falls through to Agor's permission UI via the executor's canUseTool hook
 *   (see sdk-handlers/claude/permissions/permission-hooks.ts). MCP tool calls
 *   for the built-in `agor` server and any attached MCP servers are
 *   auto-approved by that same hook, so MCP-heavy sessions don't
 *   death-by-modal. Users can flip a running session to `acceptEdits` or
 *   `bypassPermissions` mid-flight from the session UI. Applies to both the
 *   Claude Agent SDK (`claude-code`) and interactive CLI (`claude-code-cli`)
 *   paths, which share this default.
 * - Codex: 'allow-all' — maps to sandbox `workspace-write` + approval
 *   `never` + network-on. Codex's MCP auto-approve is wired through
 *   `default_tools_approval_mode = "approve"` on each server config
 *   (see prompt-service.ts buildMcpServersConfig), so Agor self-calls
 *   don't get silently cancelled by the elicitation prompt. Workspace
 *   sandbox still constrains shell exec.
 * - Gemini: 'autoEdit' (unchanged — pending separate audit)
 * - OpenCode: 'autoEdit' (unchanged — pending separate audit)
 * - Cursor: 'bypassPermissions' — scaffolded as autonomous until the SDK
 *   exposes/Agor wires a permission callback.
 *
 * Users / parent sessions / per-session overrides still trump these
 * defaults via resolvePermissionConfig.
 */
export function getDefaultPermissionMode(agenticTool: AgenticToolName): PermissionMode {
  switch (agenticTool) {
    case 'gemini':
      return 'autoEdit'; // Native Gemini SDK mode
    case 'codex':
      return 'allow-all'; // Maps to Codex sandbox=workspace-write + approval=never
    case 'opencode':
      return 'autoEdit'; // OpenCode auto-approves, similar to Gemini
    case 'copilot':
      return 'acceptEdits'; // Copilot uses same semantics as Claude Code
    case 'cursor':
      return 'bypassPermissions'; // Cursor SDK is experimental/autonomous until permission callbacks exist
    default:
      return 'auto'; // Claude Code (SDK + CLI): model-classifier permissions
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

  /**
   * Unix username to impersonate when executing this session
   *
   * Set once at session creation time from the creator's unix_username.
   * IMMUTABLE - never changes, even if the user's unix_username changes.
   *
   * Why immutable?
   * - SDK sessions (Claude Code, Codex) store data in user home directories
   * - Changing unix_username would break access to existing SDK session state
   * - If unix user no longer exists, operations will fail (expected behavior)
   *
   * DEFENSIVE: Before prompting, we validate that creator's current unix_username
   * matches session.unix_username. If they differ, reject the prompt with clear error.
   */
  unix_username: string | null;

  /** Branch ID - all sessions must be associated with an Agor-managed branch */
  branch_id: BranchID;

  /**
   * Board ID from the session's branch (populated via LEFT JOIN)
   *
   * This is a computed property populated by the repository layer when fetching sessions.
   * It avoids N+1 queries by joining with the branches table.
   * Null if the branch is not placed on any board.
   */
  branch_board_id?: BoardID | null;

  /**
   * External/user-facing URL for viewing this session in the UI.
   *
   * Computed property added by the repository layer.
   * Format: `{baseUrl}/ui/s/{sessionShortId}/`
   * Visiting the URL resolves the session, switches to its branch's
   * board, and opens the conversation panel. Always present when the
   * repo computes it (baseUrl available); board lookup happens at
   * click time, so we don't need to know about the board to mint the
   * URL.
   */
  url: string | null;

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
    /** Message index where fork occurred (count of parent's messages at fork time) */
    fork_point_message_index?: number;
    /** Parent session that spawned this one (child relationship) */
    parent_session_id?: SessionID;
    /** Task where spawn occurred */
    spawn_point_task_id?: TaskID;
    /** Message index where spawn occurred (count of parent's messages at spawn time) */
    spawn_point_message_index?: number;
    /** Child sessions spawned from this session */
    children: SessionID[];
  };

  // Tasks
  /** Task IDs in this session */
  tasks: TaskID[];

  // UI metadata
  /** Session title (user-provided or auto-generated) */
  title?: string;
  /** Session description (legacy field, may contain first prompt) */
  description?: string;

  // Permission config (session-level permission settings)
  permission_config?: {
    /** Permission mode for agent tool execution (Claude/Gemini unified mode)
     *  Tool-level permissions are handled by SDK via settings.json files */
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
    /** Effort level for reasoning depth (default: high) */
    effort?: EffortLevel;
    /** Claude Code advisor model (e.g., 'opus', 'sonnet', 'fable'); unset means no session override */
    advisorModel?: string;
    /**
     * Provider ID for OpenCode sessions (e.g., 'openai', 'anthropic', 'opencode')
     * Used in combination with model to specify which provider's API to use
     * Only applicable when agentic_tool='opencode'
     */
    provider?: string;
  };

  /**
   * Claude Code CLI adapter state. Only set when `agentic_tool === 'claude-code-cli'`.
   * Persisted on the session row's `data` blob so the daemon-side watcher can
   * resume tailing the JSONL across restarts (see
   * docs/internal/claude-code-cli-integration-analysis-2026-05-14.md).
   */
  cli_state?: {
    /** Bytes consumed from the JSONL — resume point on watcher restart. */
    watcher_offset?: number;
    /** ISO 8601 of the most recent processed JSONL line. Telemetry. */
    last_event_ts?: string;
    /** `uuid` of the most recent processed JSONL line. Sanity / dedup. */
    last_event_uuid?: string;
    /** Slugged dir under `~/.claude/projects/` (`/` and `.` → `-`). */
    slug?: string;
    /** Absolute path to the JSONL file. */
    jsonl_path?: string;
    /** Zellij pane handle for PTY-injection targeting. */
    zellij_pane_id?: string;
    /** Zellij tab name (`cli-<short>` by convention). */
    zellij_tab_name?: string;
    /**
     * In-flight turn snapshot. Written on `user_message`, set to `null`
     * on `turn_end` (not undefined — `deepMerge` in
     * `SessionRepository.update` skips undefined, so an explicit `null`
     * is the documented "clear this field" signal). Lets the watcher
     * rehydrate the task linkage for assistant/tool messages that
     * arrive after a daemon restart — without this, post-restart events
     * would orphan and `turn_end` would skip closing the task.
     * Analytics accumulated mid-turn (per-message usage,
     * lastAssistantRaw) are *not* persisted; only the linkage is
     * recovered.
     */
    active_turn?: {
      task_id: string;
      user_message_index: number;
      started_at_ms: number;
    } | null;
  };

  /**
   * Billing model for this session. CLI sessions default to 'subscription'
   * (Claude Pro/Max interactive limits), SDK sessions to 'api-key' or
   * 'unknown'. Drives the cost-UI caption and the 5h billing-window banner.
   */
  billing_mode?: 'subscription' | 'api-key' | 'unknown';

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
  scheduled_from_branch: boolean;

  /**
   * First-class schedule this session was spawned from (if any).
   *
   * Nullable: null for ad-hoc sessions and for back-compat rows that
   * predate the `schedules` table. `ON DELETE SET NULL` so when a
   * schedule is removed, its sessions become orphaned runs rather
   * than cascading deletions.
   *
   * Use this as the canonical link to a run's schedule;
   * `scheduled_from_branch` + `scheduled_run_at` are kept for dedup
   * and UI back-compat.
   */
  schedule_id?: ScheduleID;

  /**
   * Whether this session is ready to receive a new prompt
   *
   * Set to true when a task completes successfully, indicating the agent is ready for more work.
   * Cleared when the user opens the conversation drawer (acknowledging completion).
   * Used to highlight branch cards to show which sessions need attention.
   */
  ready_for_prompt: boolean;

  // ===== Callback Configuration =====

  /**
   * Callback configuration for child session completion notifications
   *
   * When a child session (spawned via subsession) completes its task,
   * Agor can automatically notify the parent session with relevant context.
   *
   * Default behavior: Callbacks enabled with default template.
   */
  callback_config?: {
    /** Enable/disable child completion callbacks (default: true for spawn, false for create) */
    enabled?: boolean;
    /** Custom Handlebars template for callback messages */
    template?: string;
    /** Whether to include last assistant message content inline (default: true) */
    include_last_message?: boolean;
    /** Whether to include original spawn prompt in callback (default: false) */
    include_original_prompt?: boolean;
    /**
     * Session ID to notify on completion (for remote session callbacks)
     *
     * When set, completion callbacks are sent to this session instead of
     * (or in addition to) the genealogy parent. This enables cross-branch
     * callbacks where a session creates another session on a different branch
     * and wants to be notified when it completes.
     *
     * Defaults to the creating session's ID when enableCallback is true
     * in agor_sessions_create.
     */
    callback_session_id?: SessionID;
    /**
     * User ID of the person who set up this callback.
     *
     * Used as queued_by_user_id when the callback is delivered, so the
     * resulting task is attributed to the callback setter, not the target
     * session owner. Execution still runs as the target session's Unix user.
     */
    callback_created_by?: string;
    /**
     * Callback firing mode:
     * - "once": Fire callback on first completion, then auto-disable (default)
     * - "persistent": Fire on every completion (legacy behavior)
     */
    callback_mode?: 'once' | 'persistent';
  };

  // ===== Fork Origin =====

  /**
   * Tracks how this session was created via fork:
   * - "btw": Ephemeral fork created via sessions.prompt mode:"btw" or UI btw button
   *
   * Undefined for regular forks, spawned sessions, or directly created sessions.
   * Sessions with fork_origin:"btw" are auto-archived after task completion.
   */
  fork_origin?: 'btw';

  // ===== Archive State =====

  /**
   * Whether this session is archived (soft deleted)
   *
   * Usually cascaded from branch archive, but can also be manually archived.
   * Archived sessions are hidden from UI but data preserved for analytics.
   */
  archived: boolean;

  /**
   * Reason for archiving
   *
   * - 'branch_archived': Cascaded from parent branch being archived
   * - 'manual': User manually archived this session
   * - 'parent_archived': Cascaded from parent session being manually archived
   * - 'btw_completed': Ephemeral btw fork auto-archived after task completion
   */
  archived_reason?: 'branch_archived' | 'manual' | 'parent_archived' | 'btw_completed';

  /**
   * Durable non-genealogy relationships involving this session.
   *
   * These are separate from genealogy.parent_session_id/forked_from_session_id.
   * For example, a session in branch A can create a remote session in branch B;
   * branch B keeps its own genealogy shape, while branch A can still render a
   * muted/surrogate child card for track-record and navigation purposes.
   */
  remote_relationships?: {
    as_source?: SessionRelationship[];
    as_target?: SessionRelationship[];
  };

  /**
   * UI-only marker for a remote-created session rendered as a surrogate in the
   * source branch tree. The canonical session still lives in `target_branch_id`;
   * clicking the surrogate should navigate to/open that real session.
   */
  remote_surrogate?: {
    relationship: SessionRelationship;
    source_session_id: SessionID;
    source_branch_id: BranchID;
    target_branch_id: BranchID;
  };
}

/**
 * Minimal persisted session state needed to decide whether a new task can
 * start immediately.
 *
 * `ready_for_prompt` is intentionally not equivalent to promptability: the UI
 * also uses it as an attention/acknowledgement flag (for example timed-out
 * permission requests can set it true). Use this helper instead of checking
 * either field directly at task-execution boundaries.
 */
export type SessionPromptState = Pick<Session, 'status' | 'ready_for_prompt'>;

export type PromptableSessionState =
  | { status: typeof SessionStatus.IDLE; ready_for_prompt: boolean }
  | { status: typeof SessionStatus.FAILED; ready_for_prompt: true };

export function sessionCanStartTask(status: Session['status'], readyForPrompt?: boolean): boolean {
  return (
    status === SessionStatus.IDLE || (status === SessionStatus.FAILED && readyForPrompt === true)
  );
}

export function isSessionPromptable<T extends SessionPromptState>(
  session: T
): session is T & PromptableSessionState {
  return sessionCanStartTask(session.status, session.ready_for_prompt);
}

export const EXECUTING_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  SessionStatus.RUNNING,
  SessionStatus.STOPPING,
  SessionStatus.AWAITING_PERMISSION,
  SessionStatus.AWAITING_INPUT,
]);

export type SessionExecutionState = Pick<Session, 'status'>;

export function isSessionExecuting(session: SessionExecutionState): boolean {
  return EXECUTING_SESSION_STATUSES.has(session.status);
}

export type SessionRelationshipType = 'remote_create';

/**
 * Durable links between sessions that are not necessarily canonical
 * branch-local genealogy. Cross-branch delegation uses this instead of
 * genealogy.parent_session_id so the local session tree, recursive delete,
 * and fork/spawn semantics remain branch-local.
 */
export interface SessionRelationship {
  relationship_id: SessionRelationshipID;
  source_session_id: SessionID;
  target_session_id: SessionID;
  relationship_type: SessionRelationshipType;
  created_by: UserID;
  created_at: string;
  updated_at?: string | null;
  callback_enabled: boolean;
  callback_session_id?: SessionID | null;
  data?: Record<string, unknown> | null;
}

/**
 * Gateway source metadata denormalized into session.custom_context.gateway_source
 *
 * Present on sessions created via messaging platform integrations (Slack, Discord, GitHub).
 * Stamped at creation time and immutable — avoids N+1 lookups on the gatewayChannels table.
 */
export interface GatewaySource {
  channel_id: string;
  channel_name: string;
  channel_type: string;
  thread_id: string;
  /** GitHub-specific: "owner/repo" format */
  github_repo?: string;
  /** GitHub-specific: PR/issue number */
  github_issue_number?: number;
  /** GitHub-specific: only post last message */
  last_message_only?: boolean;
  /** Slack-specific provenance */
  slack_team_id?: string;
  slack_channel_id?: string;
  slack_channel_name?: string;
  slack_root_ts?: string;
  slack_trigger_ts?: string;
}

/**
 * Check if a session is a gateway session (created via Slack, Discord, GitHub, etc.)
 *
 * Gateway sessions have `custom_context.gateway_source` set at creation time.
 */
export function isGatewaySession(session: Pick<Session, 'custom_context'>): boolean {
  const ctx = session.custom_context as Record<string, unknown> | undefined;
  return !!ctx?.gateway_source;
}

/**
 * Get the gateway source from a session, or null if not a gateway session.
 */
export function getGatewaySource(session: Pick<Session, 'custom_context'>): GatewaySource | null {
  const ctx = session.custom_context as Record<string, unknown> | undefined;
  const source = ctx?.gateway_source;
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  if (!s.channel_id || !s.channel_name || !s.channel_type || !s.thread_id) return null;
  return source as GatewaySource;
}

/**
 * Session type categories matching UI rendering in BranchCard
 */
export type SessionType = 'gateway' | 'scheduled' | 'agent';

/**
 * Determine the session type category.
 */
export function getSessionType(
  session: Pick<Session, 'custom_context' | 'scheduled_from_branch'>
): SessionType {
  if (isGatewaySession(session)) return 'gateway';
  if (session.scheduled_from_branch) return 'scheduled';
  return 'agent';
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
   * Template: "Check PR {{branch.pull_request_url}}"
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
   * Whether this run was triggered manually via execute-now (vs. cron tick).
   */
  triggered_manually?: boolean;

  /**
   * User ID that manually triggered this run. Only set when
   * `triggered_manually` is true.
   */
  triggered_by?: string;

  /**
   * Snapshot of schedule config at execution time.
   *
   * Preserves configuration even if the schedule is later modified or
   * deleted. Useful for debugging and understanding past runs.
   *
   * `schedule_id` was added when schedules became first-class — it lets
   * "open the schedule" links resolve even after the live schedule has
   * been deleted (the FK on `sessions.schedule_id` is SET NULL on
   * delete, but the snapshot still carries the ID for forensics).
   */
  schedule_config_snapshot?: {
    /** Optional first-class schedule ID; nullable for pre-#1253 rows. */
    schedule_id?: string;
    /** Cron expression that triggered this run */
    cron: string;
    /** Timezone for cron evaluation */
    timezone: string;
    /** Retention policy at run time */
    retention: number;
    /** Concurrency policy at run time (applies to both cron and manual paths) */
    allow_concurrent_runs?: boolean;
  };
}

/**
 * Configuration for spawning a child session
 *
 * Provides fine-grained control over spawned session settings,
 * overriding defaults from parent session or user preferences.
 */
export interface SpawnConfig {
  /** Prompt for the spawned session (required) */
  prompt: string;

  /** Optional title for the spawned session */
  title?: string;

  /** Agentic tool to use (defaults to parent's tool) */
  agent?: AgenticToolName;

  /** Permission mode override (defaults based on config preset) */
  permissionMode?: PermissionMode;

  /** Model configuration override */
  modelConfig?: {
    mode?: 'alias' | 'exact';
    model?: string;
    effort?: EffortLevel;
    /** Claude Code advisor model (e.g., 'opus', 'sonnet', 'fable'); ignored for non-Claude tools. */
    advisorModel?: string;
    /**
     * Provider ID (OpenCode only, e.g. 'anthropic', 'openai', 'opencode').
     * Persisted on session.model_config.provider. Ignored for non-OpenCode tools.
     */
    provider?: string;
  };

  /** Codex sandbox mode (codex only) */
  codexSandboxMode?: CodexSandboxMode;

  /** Codex approval policy (codex only) */
  codexApprovalPolicy?: CodexApprovalPolicy;

  /** Codex network access (codex only) */
  codexNetworkAccess?: boolean;

  /** MCP server IDs to attach to spawned session */
  mcpServerIds?: string[];

  /** Enable callback to parent on completion (default: true) */
  enableCallback?: boolean;

  /** Callback mode: "once" (default) fires once then auto-disables, "persistent" fires every time */
  callbackMode?: 'once' | 'persistent';

  /** Include child's final result in callback (default: true) */
  includeLastMessage?: boolean;

  /** Include original spawn prompt in callback (default: false) */
  includeOriginalPrompt?: boolean;

  /** Extra instructions appended to spawn prompt */
  extraInstructions?: string;

  /** Task ID to link as spawn point */
  task_id?: string;

  /**
   * Session-scope env var names (from the spawner / session creator) to
   * expose in the spawned session's executor process. Only the session's
   * creator or an admin/superadmin can set this — otherwise it is ignored.
   */
  envVarNames?: string[];
}
