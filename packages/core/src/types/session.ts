// src/types/session.ts

import type {
  AgenticToolName,
  ClaudeCodePermissionMode,
  CodexApprovalPolicy,
  CodexPermissionMode,
  CodexSandboxMode,
  GeminiPermissionMode,
} from './agentic-tool';
import type { ContextFilePath } from './context';
import type { SessionID, TaskID, WorktreeID } from './id';

export const SessionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
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
};

/**
 * Get the default permission mode for a given agentic tool
 *
 * Each agentic tool has different permission mode capabilities and recommended defaults:
 * - Claude Code: 'acceptEdits' (auto-accept file edits, prompt for other tools)
 * - Cursor: 'acceptEdits' (same as Claude Code)
 * - Codex: 'auto' (auto-approve safe operations, ask for dangerous ones)
 * - Gemini: 'acceptEdits' (same as Claude Code)
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

  /** Which agentic coding tool is running this session (Claude Code, Cursor, Codex, Gemini) */
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
    /** Codex-specific dual permission config (sandboxMode + approvalPolicy) */
    codex?: {
      /** Sandbox mode controls WHERE Codex can write (filesystem boundaries) */
      sandboxMode: CodexSandboxMode;
      /** Approval policy controls WHETHER Codex asks before executing */
      approvalPolicy: CodexApprovalPolicy;
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
  };

  // Custom context for Handlebars templates
  /**
   * User-defined JSON context for Handlebars templates in zone triggers
   * Example: { "teamName": "Backend", "sprintNumber": 42 }
   * Access in templates: {{ session.context.teamName }}
   */
  custom_context?: Record<string, unknown>;
}
