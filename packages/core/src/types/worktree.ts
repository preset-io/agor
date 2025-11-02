// src/types/worktree.ts
import type { BoardID, UUID, WorktreeID } from './id';
import type { WorktreeName } from './repo';

/**
 * Git worktree - First-class entity for isolated development contexts
 *
 * Worktrees are persistent work contexts that outlive individual sessions.
 * Each worktree has:
 * - Isolated git working directory and branch
 * - Environment configuration and runtime state
 * - Work metadata (issue, PR, notes)
 * - Session history
 *
 * Relationship to sessions:
 * - Sessions = ephemeral conversations with AI agents
 * - Worktrees = persistent work contexts (git + environment + metadata)
 * - Multiple sessions can work on the same worktree over time
 */
export interface Worktree {
  // ===== Identity =====

  /** Unique worktree identifier (UUIDv7) */
  worktree_id: WorktreeID;

  /** Repository this worktree belongs to */
  repo_id: UUID;

  /**
   * Unique numeric ID for this worktree (auto-assigned, sequential)
   *
   * Used in environment templates for port allocation:
   * Example: {{add 9000 WORKTREE_UNIQUE_ID}} → 9001, 9002, 9003, ...
   *
   * Auto-incremented when worktree is created (1, 2, 3, ...)
   */
  worktree_unique_id: number;

  /** Timestamps */
  created_at: string;
  updated_at: string;

  /** User who created this worktree */
  created_by: UUID;

  // ===== Materialized (for indexes/queries) =====

  /**
   * Worktree name (slug format)
   *
   * Used for:
   * - Directory name: ~/.agor/worktrees/{repo-slug}/{name}
   * - Default branch name (if creating new branch)
   * - CLI references
   *
   * Examples: "main", "feat-auth", "exp-rewrite"
   */
  name: WorktreeName;

  /**
   * Git ref (branch/tag/commit) currently checked out
   *
   * Examples: "feat-auth", "main", "v1.2.3", "a1b2c3d"
   */
  ref: string;

  // ===== File System =====

  /**
   * Absolute path to worktree directory
   *
   * Example: "/Users/max/.agor/worktrees/myapp/feat-auth"
   */
  path: string;

  // ===== Git State (Current) =====

  /**
   * Branch this worktree diverged from
   *
   * Example: "main" (if this is a feature branch)
   */
  base_ref?: string;

  /**
   * SHA at worktree creation (base commit)
   *
   * Tracks where this branch started.
   */
  base_sha?: string;

  /**
   * Latest commit SHA in this worktree
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
   * true:  Branch was created during worktree creation
   * false: Branch existed before (tracked from remote or local)
   */
  new_branch: boolean;

  // ===== Work Context (Persistent Across Sessions) =====

  /**
   * Board this worktree belongs to (if any)
   *
   * Worktrees can live on ONE board (not many).
   * Sessions within the worktree are accessed through the worktree card.
   */
  board_id?: BoardID;

  /**
   * Associated GitHub/GitLab issue
   *
   * Links worktree to issue it addresses.
   * Worktree-level (not session) because work persists across sessions.
   *
   * Example: "https://github.com/org/repo/issues/123"
   */
  issue_url?: string;

  /**
   * Associated pull request
   *
   * Links worktree to PR containing changes.
   * Auto-populated when user creates PR.
   *
   * Example: "https://github.com/org/repo/pull/42"
   */
  pull_request_url?: string;

  /**
   * Freeform notes about this worktree
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
   * Each worktree gets its own environment instance with unique ports.
   */
  environment_instance?: WorktreeEnvironmentInstance;

  // ===== Sessions =====

  /**
   * Last time this worktree was used
   *
   * Updated when sessions start/complete.
   */
  last_used: string;

  // ===== Custom Context =====

  /**
   * Custom context for Handlebars templates
   *
   * User-defined variables for zone triggers, reports, etc.
   */
  custom_context?: Record<string, unknown>;
}

/**
 * Worktree environment instance
 *
 * Runtime state for a worktree's environment (dev server, Docker, etc.).
 * Template variables are resolved from:
 * - Built-in: WORKTREE_UNIQUE_ID, WORKTREE_NAME, WORKTREE_PATH, REPO_SLUG
 * - Custom: worktree.custom_context (JSON object)
 */
export interface WorktreeEnvironmentInstance {
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
}

/**
 * Repository environment configuration template
 *
 * Defines how to run environments for all worktrees in a repo.
 * Uses Handlebars templating with scoped entity references.
 *
 * Template context (always available):
 * - {{worktree.unique_id}} - Auto-assigned unique number (1, 2, 3, ...)
 * - {{worktree.name}} - Worktree name (e.g., "feat-auth")
 * - {{worktree.path}} - Absolute path to worktree directory
 * - {{repo.slug}} - Repository slug (e.g., "agor")
 * - {{custom.*}} - Any custom context from worktree.custom_context
 * - {{add a b}}, {{sub a b}}, {{mul a b}} - Math helpers
 */
export interface RepoEnvironmentConfig {
  /**
   * Command to start environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} up -d"
   * - "UI_PORT={{add 9000 worktree.unique_id}} DAEMON_PORT={{add 8000 worktree.unique_id}} pnpm dev"
   * - "PORT={{add 5000 worktree.unique_id}} npm start"
   */
  up_command: string;

  /**
   * Command to stop environment (Handlebars template)
   *
   * Examples:
   * - "docker compose -p {{worktree.name}} down"
   * - "pkill -f 'vite.*{{add 9000 worktree.unique_id}}'"
   */
  down_command: string;

  /**
   * Optional health check configuration
   */
  health_check?: {
    /** Health check type */
    type: 'http' | 'tcp' | 'process';
    /**
     * URL template for HTTP checks
     *
     * Example: "http://localhost:{{add 9000 worktree.unique_id}}/health"
     */
    url_template?: string;
  };

  /**
   * App URL template (Handlebars template)
   * URL to access the running application
   *
   * Example: "http://localhost:{{add 5000 worktree.unique_id}}"
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
   * - "docker compose -p {{worktree.name}} logs --tail=100"
   * - "tail -n 100 /var/log/app-{{worktree.unique_id}}.log"
   * - "kubectl logs deployment/{{worktree.name}} --tail=100"
   */
  logs_command?: string;
}
