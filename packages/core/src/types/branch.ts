// src/types/branch.ts
import type { BoardID, BranchID, UUID } from './id';
import type { KnowledgeNamespaceID, KnowledgeVisibility } from './knowledge';
import type { BranchName } from './repo';

/**
 * Git branch - First-class entity for isolated development contexts
 *
 * Branches are persistent work contexts that outlive individual sessions.
 * Each branch has:
 * - Isolated git working directory and branch
 * - Environment configuration and runtime state
 * - Work metadata (issue, PR, notes)
 * - Session history
 *
 * Relationship to sessions:
 * - Sessions = ephemeral conversations with AI agents
 * - Branches = persistent work contexts (git + environment + metadata)
 * - Multiple sessions can work on the same branch over time
 */
export interface Branch {
  // ===== Identity =====

  /** Unique branch identifier (UUIDv7) */
  branch_id: BranchID;

  /** Repository this branch belongs to */
  repo_id: UUID;

  /**
   * Unique numeric ID for this branch (auto-assigned, sequential)
   *
   * Used in environment templates for port allocation:
   * Example: {{add 9000 BRANCH_UNIQUE_ID}} → 9001, 9002, 9003, ...
   *
   * Auto-incremented when branch is created (1, 2, 3, ...)
   */
  branch_unique_id: number;

  /** Start command - initialized from repo template, then user-editable (e.g., "pnpm dev") */
  start_command?: string;

  /** Stop command - initialized from repo template, then user-editable (e.g., "pkill -f 'pnpm dev'") */
  stop_command?: string;

  /** Nuke command - initialized from repo template, then user-editable (e.g., "docker compose down -v") */
  nuke_command?: string;

  /** Health check URL - initialized from repo template, then user-editable (e.g., "http://localhost:5173/health") */
  health_check_url?: string;

  /** App URL - initialized from repo template, then user-editable (e.g., "http://localhost:5173") */
  app_url?: string;

  /** Logs command - initialized from repo template, then user-editable (e.g., "docker logs agor-daemon") */
  logs_command?: string;

  /**
   * Name of the environment variant this branch is currently rendered from.
   *
   * References a key under `repo.environment.variants` at the time the
   * branch's command fields were last rendered. Used by the UI to show
   * which variant is "active" and by the admin-only re-render flow to know
   * the last-rendered variant.
   *
   * null/undefined means "no variant tracked" (pre-v2 / legacy branches)
   * or that the repo has no environment config.
   */
  environment_variant?: string;

  /** Timestamps */
  created_at: string;
  updated_at: string;

  /** User who created this branch */
  created_by: UUID;

  /**
   * External/user-facing URL for viewing this branch in the UI.
   *
   * Computed property added by the repository layer. Optional —
   * undefined on inputs / fixtures constructed by hand; on read paths
   * from the repo it's always present as `string | null` (null when
   * the branch isn't placed on a board, since the share link has
   * nothing to switch to).
   * Format: `{baseUrl}/ui/w/{branchShortId}/`
   * Visiting the URL resolves the branch, switches to its board,
   * and recenters the canvas on its card. See
   * `apps/agor-ui/src/hooks/useUrlState.ts`.
   */
  url?: string | null;

  // ===== Materialized (for indexes/queries) =====

  /**
   * Branch name (slug format)
   *
   * Used for:
   * - Directory name: ~/.agor/worktrees/{repo-slug}/{name}
   * - Default branch name (if creating new branch)
   * - CLI references
   *
   * Examples: "main", "feat-auth", "exp-rewrite"
   */
  name: BranchName;

  /**
   * Git ref (branch/tag/commit) currently checked out
   *
   * Examples: "feat-auth", "main", "v1.2.3", "a1b2c3d"
   */
  ref: string;

  /**
   * Type of ref (branch or tag)
   *
   * - 'branch': ref is a branch name (default)
   * - 'tag': ref is a tag name
   */
  ref_type?: 'branch' | 'tag';

  // ===== File System =====

  /**
   * Absolute path to branch directory
   *
   * Example: "/Users/max/.agor/worktrees/myapp/feat-auth"
   */
  path: string;

  // ===== Git State (Current) =====

  /**
   * Branch this branch diverged from
   *
   * Example: "main" (if this is a feature branch)
   */
  base_ref?: string;

  /**
   * SHA at branch creation (base commit)
   *
   * Tracks where this branch started.
   */
  base_sha?: string;

  /**
   * Latest commit SHA in this branch
   *
   * Updated when sessions make commits.
   */
  last_commit_sha?: string;

  /**
   * Remote tracking branch (if any)
   *
   * Examples: "origin/feat-auth", "upstream/main"
   */
  tracking_branch?: string;

  /**
   * Whether this ref is a new branch created by Agor
   *
   * true:  Branch was created during branch creation
   * false: Branch existed before (tracked from remote or local)
   */
  new_branch: boolean;

  // ===== Work Context (Persistent Across Sessions) =====

  /**
   * Board this branch belongs to (if any)
   *
   * Branches can live on ONE board (not many).
   * Sessions within the branch are accessed through the branch card.
   */
  board_id?: BoardID;

  /**
   * Associated GitHub/GitLab issue
   *
   * Links branch to issue it addresses.
   * Branch-level (not session) because work persists across sessions.
   *
   * Example: "https://github.com/org/repo/issues/123"
   */
  issue_url?: string;

  /**
   * Associated pull request
   *
   * Links branch to PR containing changes.
   * Auto-populated when user creates PR.
   *
   * Example: "https://github.com/org/repo/pull/42"
   */
  pull_request_url?: string;

  /**
   * Freeform notes about this branch
   *
   * User can document:
   * - What they're working on
   * - Blockers or issues
   * - Design decisions
   * - Next steps
   *
   * Supports markdown.
   */
  notes?: string;

  // ===== Environment =====

  /**
   * Environment instance (if repo has environment config)
   *
   * Tracks runtime state, process info, variable values.
   * Each branch gets its own environment instance with unique ports.
   */
  environment_instance?: BranchEnvironmentInstance;

  // ===== Sessions =====

  /**
   * Last time this branch was used
   *
   * Updated when sessions start/complete.
   */
  last_used: string;

  // ===== Custom Context =====

  /**
   * Custom context for Handlebars templates and agent metadata
   *
   * User-defined variables for zone triggers, reports, etc.
   * Also stores persisted agent config under the 'agent' key.
   */
  custom_context?: Record<string, unknown>;

  // ===== MCP Server Configuration =====

  /**
   * Default MCP servers to attach to new sessions in this branch
   *
   * When creating a session, MCP servers are resolved with this priority:
   * 1. Caller explicitly specifies mcpServerIds → use those
   * 2. Branch mcp_server_ids → use these
   * 3. User defaults → fallback
   *
   * Not used during spawn (spawn inherits from parent session).
   * References to deleted MCP servers are silently skipped.
   */
  mcp_server_ids?: string[];

  // ===== UI State =====

  /**
   * Whether this branch needs attention (highlighted state)
   *
   * Set to true when:
   * - Branch is newly created
   * - Any session in the branch has ready_for_prompt=true
   *
   * Cleared when user interacts with the branch card.
   * Used to draw attention to new or ready branches on the board.
   */
  needs_attention: boolean;

  // ===== Archive State =====

  /**
   * Whether this branch is archived (soft deleted)
   *
   * Archived branches:
   * - Hidden from board display
   * - Metadata preserved in database
   * - Can be unarchived later
   */
  archived: boolean;

  /**
   * When this branch was archived (if archived)
   */
  archived_at?: string;

  /**
   * User who archived this branch
   */
  archived_by?: UUID;

  /**
   * Filesystem status
   *
   * Creation states:
   * - 'creating': DB record created, git worktree add in progress
   * - 'ready': Branch fully created and ready to use
   * - 'failed': Branch creation failed (git worktree add error)
   *
   * Archive states (set when branch is archived):
   * - 'preserved': Filesystem left untouched
   * - 'cleaned': git clean -fdx run (removes node_modules, build artifacts)
   * - 'deleted': Entire branch directory deleted from disk
   *
   * Note: null/undefined means 'ready' for backward compatibility
   */
  filesystem_status?: 'creating' | 'ready' | 'failed' | 'preserved' | 'cleaned' | 'deleted';

  /**
   * Error message when filesystem_status is 'failed'
   *
   * Contains the reason why branch creation failed (e.g., git worktree add error).
   * Cleared when status transitions away from 'failed'.
   */
  error_message?: string;

  // ===== RBAC: App-layer permissions (rbac.md) =====

  /**
   * Whether this branch uses its own permission fields or aligns to board defaults.
   * Existing branches default/read as 'override' for backcompat.
   */
  permission_source?: BranchPermissionSource;

  /**
   * Permission level for non-owners
   *
   * - 'none': No access (branch is completely private to owners)
   * - 'view': Can read branches/sessions/tasks/messages
   * - 'session': View + can create new sessions (running as own identity) and prompt own sessions
   * - 'prompt': View + can create tasks/messages in ANY session (run agents as session creator's identity)
   * - 'all': Full control (create/patch/delete sessions)
   *
   * Note: Owners always have 'all' permission regardless of this setting.
   */
  others_can?: BranchPermissionLevel;

  // ===== RBAC: OS-layer permissions (unix-user-modes.md) =====

  /**
   * Unix group for this branch (if Unix modes enabled)
   *
   * Format: 'agor_wt_<short-id>'
   * Owners are added to this group for filesystem access.
   */
  unix_group?: string;

  /**
   * Filesystem access level for non-owners ("others" in Unix terms)
   *
   * Controls OS-level permissions for users who are NOT branch owners.
   * Branch owners always have full access (7 = rwx) via group membership.
   *
   * - 'none': Others get no access (chmod 2770 → drwxrws---)
   * - 'read': Others can read files (chmod 2775 → drwxrwsr-x)
   * - 'write': Others can read and write files (chmod 2777 → drwxrwsrwx)
   *
   * This controls OS-level permissions independent of app-layer 'others_can'.
   */
  others_fs_access?: 'none' | 'read' | 'write';

  // ===== Branch Storage Mode =====
  // See context/explorations/clone-redesign.md.

  /**
   * How this branch's filesystem is materialised.
   *
   * - 'worktree' (default, legacy): native `git worktree add` — the working
   *   dir's `.git` is a `gitdir:` pointer file into the shared base repo at
   *   `~/.agor/repos/<slug>/`. Object store and `.git/config` are shared
   *   with siblings.
   * - 'clone': self-standing `git clone` — the working dir has its own real
   *   `.git/` directory, isolated `.git/config`, no `gitdir:` pointer. Closes
   *   the cross-branch credential/config leak vectors (Layer A defenses are
   *   then belt-and-braces, not load-bearing).
   *
   * Selected at create time. Existing rows default to 'worktree'.
   */
  storage_mode?: 'worktree' | 'clone';

  /**
   * Optional `git clone --depth N` for shallow clones. Only meaningful when
   * `storage_mode === 'clone'`. NULL/undefined = full clone (preserve all
   * history). A positive integer N = shallow clone of N commits — smaller
   * disk footprint, but `git log` past N commits is broken and some rebase
   * operations fail.
   */
  clone_depth?: number;

  // ===== Session Sharing (legacy identity-borrow opt-in) =====

  /**
   * DANGEROUS: Allow legacy "identity borrowing" on session spawn/fork.
   *
   * Default (false / undefined): When user A calls `agor_sessions_spawn` or
   * `agor_sessions_prompt(mode:"fork"|"subsession")` against user B's session,
   * the new child session is attributed to A — `child.created_by = A.id` —
   * and runs under A's Unix identity, credentials, and env vars.
   *
   * When true: legacy behavior is preserved — the child inherits
   * `parent.created_by`, so it executes under the *parent owner's* identity
   * even when spawned by a different caller. This effectively lets a
   * collaborator run code as the session creator (similar to what
   * `others_can: 'prompt'` already permits for direct prompts), and is
   * preserved only for parity with pre-existing automation that relies on it.
   *
   * Admins (role >= admin) are *always* attributed to themselves regardless
   * of this flag.
   *
   * Cross-user spawns under this flag are logged loudly by the daemon.
   */
  dangerously_allow_session_sharing?: boolean;
}

/**
 * Ordered permission levels for branch RBAC (least → most privileged).
 *
 * Single source of truth — derive types, zod schemas, DB enums, and rank maps from this.
 */
export const BRANCH_PERMISSION_LEVELS = ['none', 'view', 'session', 'prompt', 'all'] as const;

/**
 * Permission level type (for app-layer RBAC)
 */
export type BranchPermissionLevel = (typeof BRANCH_PERMISSION_LEVELS)[number];

/**
 * Source of a branch's non-owner permission defaults.
 *
 * - 'override': branch row fields are authoritative (legacy/backcompat default)
 * - 'board': branch was created to align with its board-level defaults
 */
export type BranchPermissionSource = 'board' | 'override';

// Schedules are now a first-class entity. See `Schedule` in `./schedule.ts`
// and `schedules` in `packages/core/src/db/schema.{sqlite,postgres}.ts`.

/**
 * Branch environment instance
 *
 * Runtime state for a branch's environment (dev server, Docker, etc.).
 * Template variables are resolved from:
 * - Built-in: BRANCH_UNIQUE_ID, BRANCH_NAME, BRANCH_PATH, REPO_SLUG
 * - Custom: branch.custom_context (JSON object)
 */
export interface BranchEnvironmentInstance {
  /**
   * Current environment status
   */
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

  /**
   * Process metadata (if managed by Agor)
   */
  process?: {
    /** Process ID */
    pid?: number;
    /** When process started */
    started_at?: string;
    /** Human-readable uptime */
    uptime?: string;
  };

  /**
   * Last health check result
   */
  last_health_check?: {
    timestamp: string;
    status: 'healthy' | 'unhealthy' | 'unknown';
    message?: string;
  };

  /**
   * Resolved access URLs (after template substitution)
   *
   * Example: [
   *   { name: "UI", url: "http://localhost:5173" },
   *   { name: "API", url: "http://localhost:3030" }
   * ]
   */
  access_urls?: Array<{
    name: string;
    url: string;
  }>;

  /**
   * Process logs (last N lines)
   *
   * Captured from stdout/stderr of environment process.
   */
  logs?: string[];

  /**
   * Last error output from a failed command (start/stop/nuke)
   *
   * Captures the last ~100 lines of stdout/stderr when a command exits non-zero.
   * Cleared on the next successful start.
   */
  last_error?: string;
}

/**
 * Legacy (v1) repository environment configuration — single flat command set.
 *
 * @deprecated Use {@link RepoEnvironment} (v2) with named variants. Retained
 * for migration code that wraps v1 configs as `variants.default` inside
 * {@link RepoEnvironment}.
 *
 * Template context (always available):
 * - {{branch.unique_id}} - Auto-assigned unique number (1, 2, 3, ...)
 * - {{branch.name}} - Branch name (e.g., "feat-auth")
 * - {{branch.path}} - Absolute path to branch directory
 * - {{repo.slug}} - Repository slug (e.g., "agor")
 * - {{custom.*}} - Any custom context from branch.custom_context
 * - {{add a b}}, {{sub a b}}, {{mul a b}} - Math helpers
 */
export interface RepoEnvironmentConfigV1 {
  /**
   * Command to start environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{branch.name}} up -d"
   * - "UI_PORT={{add 9000 branch.unique_id}} DAEMON_PORT={{add 8000 branch.unique_id}} pnpm dev"
   * - "PORT={{add 5000 branch.unique_id}} npm start"
   */
  up_command: string;

  /**
   * Command to stop environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{branch.name}} down"
   * - "pkill -f 'vite.*{{add 9000 branch.unique_id}}'"
   */
  down_command: string;

  /**
   * Command to nuke environment (Handlebars template)
   *
   * Destructive operation that typically removes volumes, data, and state.
   * Requires user confirmation before execution.
   *
   * Examples:
   * - "docker compose -p {{branch.name}} down -v"
   * - "rm -rf node_modules .next .cache && docker compose -p {{branch.name}} down -v"
   */
  nuke_command?: string;

  /**
   * Optional health check configuration
   */
  health_check?: {
    /** Health check type */
    type: 'http' | 'tcp' | 'process';
    /**
     * URL template for HTTP checks
     *
     * Example: "http://localhost:{{add 9000 branch.unique_id}}/health"
     */
    url_template?: string;
  };

  /**
   * App URL template (Handlebars template)
   * URL to access the running application
   *
   * Example: "http://localhost:{{add 5000 branch.unique_id}}"
   */
  app_url_template?: string;

  /**
   * Optional logs command (Handlebars template)
   * Command to fetch recent logs from the environment (non-streaming)
   *
   * Should return quickly with tail of recent logs.
   * Output is limited to 100 lines / 100KB for safety.
   *
   * Examples:
   * - "docker compose -p {{branch.name}} logs --tail=100"
   * - "tail -n 100 /var/log/app-{{branch.unique_id}}.log"
   * - "kubectl logs deployment/{{branch.name}} --tail=100"
   */
  logs_command?: string;
}

/**
 * A single named environment variant.
 *
 * Variants describe one way of running a repository's environment
 * (e.g. "dev" vs "e2e" vs "db-only"). Every variant must define
 * `start` and `stop`; other fields are optional.
 *
 * Variants may declare a single-level `extends` referring to another variant
 * in the same {@link RepoEnvironment}. The parser rejects multi-level chains,
 * missing targets, and self-extends.
 */
export interface RepoEnvironmentVariant {
  /**
   * Optional human-readable description shown in UI pickers.
   */
  description?: string;

  /**
   * Name of another variant in the same repo environment whose fields are
   * inherited, then overridden field-by-field by this variant.
   *
   * Single-level only: the target variant MUST NOT itself declare `extends`.
   */
  extends?: string;

  /**
   * Command to start the environment (Handlebars template).
   *
   * Required on a resolved variant, but may be omitted on the raw variant
   * declaration when `extends` supplies it. The parser validates that the
   * resolved variant has both `start` and `stop`.
   */
  start?: string;

  /**
   * Command to stop the environment (Handlebars template).
   *
   * Required on a resolved variant, but may be omitted on the raw variant
   * declaration when `extends` supplies it. See {@link start}.
   */
  stop?: string;

  /**
   * Destructive reset command (Handlebars template).
   * Requires user confirmation before execution.
   */
  nuke?: string;

  /**
   * Command to fetch recent logs (Handlebars template).
   * Should return quickly — output is truncated for safety.
   */
  logs?: string;

  /**
   * HTTP health check URL template (Handlebars template).
   */
  health?: string;

  /**
   * App URL template (Handlebars template).
   */
  app?: string;
}

/**
 * Repository environment configuration (v2).
 *
 * Replaces the flat v1 {@link RepoEnvironmentConfigV1} with a set of
 * named variants. `default` points at the variant used when a branch
 * is created or when no variant is explicitly chosen.
 *
 * `template_overrides` is a deployment-local, DB-only deep tree that is
 * merged into the Handlebars render context after built-in defaults but
 * before `custom.*`. It is intentionally NEVER round-tripped through
 * `.agor.yml` import/export (stripped on export, rejected on import).
 */
export interface RepoEnvironment {
  /** Schema version discriminator. Always 2. */
  version: 2;

  /**
   * Name of the default variant (must be a key in {@link variants}).
   */
  default: string;

  /**
   * Named variants keyed by variant name.
   *
   * Must include the {@link default} key.
   */
  variants: Record<string, RepoEnvironmentVariant>;

  /**
   * Deployment-local deep overrides merged into the template render
   * context after built-in defaults but before `custom.*`.
   *
   * DB-only — never exported to `.agor.yml`. Rejected on import.
   */
  template_overrides?: Record<string, unknown>;
}

/**
 * Back-compat alias: older code may still import `RepoEnvironmentConfig`.
 * New code should use {@link RepoEnvironment} (v2) directly.
 *
 * @deprecated Use {@link RepoEnvironment} or {@link RepoEnvironmentConfigV1}
 * explicitly depending on whether you need v2 or the legacy flat shape.
 */
export type RepoEnvironmentConfig = RepoEnvironmentConfigV1;

// ===== Assistants =====

export type AssistantKnowledgeGrantAccess = 'none' | 'read' | 'write';
export interface AssistantKnowledgeGrant {
  namespace_id: KnowledgeNamespaceID;
  namespace_slug: string;
  access: AssistantKnowledgeGrantAccess;
}

export interface AssistantKnowledgeConfig {
  primary_namespace_id: KnowledgeNamespaceID;
  primary_namespace_slug: string;
  memory_path_template: 'memory/{{YYYY-MM-DD}}.md';
  default_visibility: KnowledgeVisibility;
  /**
   * Assistant-tool policy for namespaces not listed in `grants`.
   *
   * This is an assistant-specific ceiling; effective access is still
   * intersected with the calling user's Knowledge namespace permission.
   */
  global_access?: AssistantKnowledgeGrantAccess;
  grants?: AssistantKnowledgeGrant[];
}

/**
 * Configuration for an assistant, stored in branch.custom_context.assistant
 *
 * Marks a branch as a long-lived "assistant" — a persistent AI companion
 * that manages other branches, maintains memory, and orchestrates work.
 */
export interface AssistantConfig {
  /** Discriminator for type narrowing */
  kind: 'assistant';
  /** Human-friendly display name (e.g., "My Assistant") */
  displayName: string;
  /** Emoji icon for this assistant (e.g., "🧑‍💻") */
  emoji?: string;
  /** Template repo slug this assistant was created from */
  frameworkRepo?: string;
  /** Framework version at creation time, for upgrade detection */
  frameworkVersion?: string;
  /** Whether this was created via the onboarding wizard */
  createdViaOnboarding?: boolean;
  /** Knowledge Base namespace and grant config for assistant memory/context. */
  kb?: AssistantKnowledgeConfig;
}

/** @deprecated Use AssistantConfig instead */
export type PersistedAgentConfig = AssistantConfig;

/**
 * Type guard: checks if a branch is an assistant.
 * Supports both new (`custom_context.assistant`) and legacy (`custom_context.agent`) storage.
 */
export function isAssistant(branch: { custom_context?: Record<string, unknown> }): boolean {
  const config = branch.custom_context?.assistant ?? branch.custom_context?.agent;
  return (
    config != null &&
    typeof config === 'object' &&
    ((config as Record<string, unknown>).kind === 'assistant' ||
      (config as Record<string, unknown>).kind === 'persisted-agent')
  );
}

/** @deprecated Use isAssistant instead */
export const isPersistedAgent = isAssistant;

/**
 * Extract the assistant config from a branch, if present.
 * Supports both new (`custom_context.assistant`) and legacy (`custom_context.agent`) storage.
 */
export function getAssistantConfig(branch: {
  custom_context?: Record<string, unknown>;
}): AssistantConfig | null {
  if (!isAssistant(branch)) return null;
  const config = (branch.custom_context!.assistant ??
    branch.custom_context!.agent) as AssistantConfig;
  return config;
}

/** @deprecated Use getAssistantConfig instead */
export const getPersistedAgentConfig = getAssistantConfig;
