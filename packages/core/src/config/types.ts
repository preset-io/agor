/**
 * Agor Configuration Types
 */

import type { DaemonResourcesConfig } from '../types/config-resources';
import type { UserRole } from '../types/user';
import type { WorktreePermissionLevel } from '../types/worktree';

/**
 * Minimum role allowed to trigger managed environment commands
 * (start/stop/nuke/logs). `'none'` disables the feature entirely.
 */
export type ManagedEnvsMinimumRole = 'none' | UserRole;

/**
 * Type for user-provided JSON data where structure is unknown or dynamic
 *
 * Use this instead of `any` when dealing with user input or dynamic data structures.
 */
// biome-ignore lint/suspicious/noExplicitAny: Escape hatch for user-provided JSON data
export type UnknownJson = any;

/**
 * Global default values
 */
export interface AgorDefaults {
  /** Default board for new sessions */
  board?: string;

  /** Default agent for new sessions */
  agent?: string;
}

/**
 * Display settings
 */
export interface AgorDisplaySettings {
  /** Table style: unicode, ascii, or minimal */
  tableStyle?: 'unicode' | 'ascii' | 'minimal';

  /** Enable color output */
  colorOutput?: boolean;

  /** Short ID length (default: 8) */
  shortIdLength?: number;
}

/**
 * Daemon settings
 */
export interface AgorDaemonSettings {
  /** Daemon port (default: 3030) */
  port?: number;

  /** Daemon host (default: localhost) */
  host?: string;

  /**
   * IP address exposed to env command templates as `{{host.ip_address}}`.
   *
   * Useful for health-check URLs that must reach the host from inside a
   * container (e.g. Superset health probes that resolve to a host-bound
   * service). When unset, the daemon auto-detects the primary non-loopback
   * IPv4 at startup and logs the resolved value.
   *
   * Set this to override autodetection (e.g. on multi-NIC hosts or when
   * the container network differs from the advertised address).
   */
  host_ip_address?: string;

  /**
   * Public URL for executors to reach the daemon.
   *
   * In local mode, defaults to `http://localhost:{port}`.
   * In containerized (k8s) mode, should be the internal service URL.
   *
   * @example
   * ```yaml
   * daemon:
   *   public_url: http://agor-daemon.agor.svc.cluster.local:3030
   * ```
   */
  public_url?: string;

  /**
   * Base URL for external/user-facing links (e.g., session URLs in Slack messages).
   *
   * Used to generate clickable URLs to sessions, boards, and other resources
   * that are sent to external platforms like Slack, email, etc.
   *
   * Defaults to `http://localhost:{port}` in development.
   * Should be set to your public domain in production (e.g., https://agor.example.com).
   *
   * Note: Should NOT include trailing slash.
   *
   * @example
   * ```yaml
   * daemon:
   *   base_url: https://agor.sandbox.preset.zone
   * ```
   */
  base_url?: string;

  /** Allow anonymous access (default: true for local mode) */
  allowAnonymous?: boolean;

  /** Require authentication for all requests (default: false) */
  requireAuth?: boolean;

  /** JWT secret (auto-generated if not provided) */
  jwtSecret?: string;

  /** Master secret for API key encryption (auto-generated if not provided) */
  masterSecret?: string;

  /** Enable built-in MCP server (default: true) */
  mcpEnabled?: boolean;

  /** Enable tool search mode: tools/list returns only essential tools,
   *  agents discover others via agor_search_tools (default: true) */
  mcpToolSearch?: boolean;

  /** Unix user the daemon runs as. Used to ensure daemon has access to all Unix groups.
   * Required when Unix isolation is enabled (worktree_rbac or unix_user_mode).
   * In dev mode without isolation, falls back to current process user. */
  unix_user?: string;

  /** Instance label for deployment identification (e.g., "staging", "prod-us-east").
   * Displayed as a Tag in the UI navbar when set. */
  instanceLabel?: string;

  /** Instance description (markdown supported).
   * Displayed as a popover around the instance label Tag. */
  instanceDescription?: string;

  /** Maximum expiry for impersonation tokens in ms (default: 3600000 = 1 hour, capped at 1 hour) */
  impersonation_token_expiry_ms?: number;

  /** Allow CORS from Sandpack/CodeSandbox bundler origins (default: true).
   * Enables artifacts on the hosted bundler to call the Agor API. */
  cors_allow_sandpack?: boolean;

  /** Additional allowed CORS origins.
   * Plain strings are exact matches. Wrap in /slashes/ for regex patterns.
   * @example
   * ```yaml
   * daemon:
   *   cors_origins:
   *     - https://my-dashboard.example.com
   *     - /\.internal\.example\.com$/
   * ```
   */
  cors_origins?: string[];

  /**
   * Number of reverse proxies in front of the daemon.
   *
   * Maps directly to Express's `app.set('trust proxy', n)`. When > 0, Express
   * (and rate-limit middleware that reads `req.ip`) will honour the rightmost
   * `n` entries of `X-Forwarded-For` and `X-Forwarded-Proto`. Setting this
   * higher than the actual hop count lets a client spoof their IP via
   * `X-Forwarded-For`, so leave it at 0 unless you actually have a proxy in
   * front of the daemon.
   *
   * Default: 0 (do not trust X-Forwarded-* headers).
   */
  trust_proxy_hops?: number;
}

/**
 * UI settings
 */
export interface AgorUISettings {
  /** UI dev server port (default: 5173) */
  port?: number;

  /** UI host (default: localhost) */
  host?: string;
}

/**
 * OpenCode.ai integration settings
 */
export interface AgorOpenCodeSettings {
  /** Enable OpenCode integration (default: false) */
  enabled?: boolean;

  /** URL where OpenCode server is running (default: http://localhost:4096) */
  serverUrl?: string;
}

/**
 * Database configuration settings
 */
export interface AgorDatabaseSettings {
  /** Database dialect (default: 'sqlite') */
  dialect?: 'sqlite' | 'postgresql';

  /** SQLite configuration */
  sqlite?: {
    /** Database file path (default: '~/.agor/agor.db') */
    path?: string;

    /** Enable WAL mode (default: true) */
    walMode?: boolean;

    /** Busy timeout in ms (default: 5000) */
    busyTimeout?: number;
  };

  /** PostgreSQL configuration */
  postgresql?: {
    /** Connection URL (postgresql://user:pass@host:port/db) */
    url?: string;

    /** Individual connection parameters (alternative to URL) */
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;

    /** Connection pool settings */
    pool?: {
      min?: number; // Default: 2
      max?: number; // Default: 10
      idleTimeout?: number; // Default: 30000ms
    };

    /** SSL/TLS configuration */
    ssl?:
      | boolean
      | {
          rejectUnauthorized?: boolean;
          ca?: string;
          cert?: string;
          key?: string;
        };

    /** Schema name (default: 'public') */
    schema?: string;
  };
}

/**
 * Codex-specific configuration
 */
export interface AgorCodexSettings {
  /** Codex home directory (default: ~/.agor/codex) */
  home?: string;
}

/**
 * Unix user isolation mode controlling how session processes get mapped to
 * OS identities.
 *
 * - `simple` — all processes run as the daemon user (no OS isolation)
 * - `insulated` — executors run as a dedicated user with per-worktree groups
 * - `strict` — sessions run as the session creator's own Unix user
 */
export type UnixUserMode = 'simple' | 'insulated' | 'strict';

/**
 * Execution settings
 */
export interface AgorExecutionSettings {
  /** Unix user to run executors as (default: undefined = run as daemon user). When set, uses sudo impersonation. */
  executor_unix_user?: string;

  /** Unix user mode: simple (no isolation), insulated (worktree groups), strict (enforce process impersonation) */
  unix_user_mode?: UnixUserMode;

  /** Enable worktree RBAC and ownership system (default: false). When enabled, enforces permission checks and Unix group isolation. */
  worktree_rbac?: boolean;

  /**
   * Allow authenticated members (and above) to open the web terminal (default: true).
   *
   * When true (default), any user with role `member` or higher can open a
   * terminal. Set to false to disable the terminal for everyone, including
   * admins; the modal is hidden from the UI in that case.
   *
   * ⚠️ Security note: this flag does NOT reason about Unix isolation. In
   * `unix_user_mode: simple` the terminal runs as the daemon user and gives the
   * user a shell with access to `~/.agor/config.yaml`, `agor.db`, and the JWT
   * secret. Safe combinations are `unix_user_mode: strict` (per-user Unix
   * account) or `insulated` (shared executor user, no daemon access). The
   * daemon emits a startup warning when this flag is enabled in `simple` mode.
   *
   * Worktree-level permissions still apply: opening a terminal against a
   * worktree requires at least `session` permission on that worktree.
   */
  allow_web_terminal?: boolean;

  /** Allow superadmin role (default: false). When true, superadmin role gets worktree RBAC bypass. Opt-in for self-hosted deployments. */
  allow_superadmin?: boolean;

  /**
   * User IDs to promote to superadmin at daemon startup (promote-only, no demotion).
   *
   * - Applied only when allow_superadmin is true
   * - Intended for bootstrap/recovery in self-hosted deployments
   * - Uses stable user IDs (UUIDv7), not emails
   */
  bootstrap_superadmin_users?: string[];

  /** Session token expiration in ms (default: 86400000 = 24 hours) */
  session_token_expiration_ms?: number;

  /** Maximum session token uses (default: 1 = single-use, -1 = unlimited) */
  session_token_max_uses?: number;

  /**
   * MCP session token expiration in ms (default: 86400000 = 24 hours).
   *
   * Applies to the internal MCP tokens minted for each Agor session
   * (aud: `agor:mcp:internal`). Every issued token now carries an `exp`
   * claim; this value controls the lifetime.
   *
   * Does NOT affect the (separate) executor-side `session_token_*` settings,
   * which gate the short-lived JWT issued to spawned subprocesses.
   */
  mcp_token_expiration_ms?: number;

  /** Sync web passwords to Unix user passwords (default: true). When enabled, passwords are synced on user creation/update. */
  sync_unix_passwords?: boolean;

  /** Permission request timeout in ms (default: 600000 = 10 minutes). When a permission request is not resolved within this time, the agent is notified and can continue. */
  permission_timeout_ms?: number;

  /**
   * Stateless filesystem mode for headless/k8s deployments without persistent volumes.
   *
   * When enabled, the agent SDK's session state (JSONL transcript file) is serialized
   * into the Agor database after each turn and restored on demand when a new pod picks
   * up a session. This allows sessions to survive pod restarts/rescheduling.
   *
   * Default: false (session files are expected to persist on the local filesystem)
   */
  stateless_fs_mode?: boolean;

  /**
   * Executor command template for remote/containerized execution.
   *
   * When null/undefined (default), executors are spawned as local subprocesses.
   * When set, the template is used to spawn executors in containers/pods.
   *
   * Template variables (substituted at spawn time):
   * - {task_id} - Unique task identifier (for pod naming)
   * - {command} - Executor command (prompt, git.clone, etc.)
   * - {unix_user} - Target Unix username
   * - {unix_user_uid} - Target Unix UID (for runAsUser)
   * - {unix_user_gid} - Target Unix GID (for fsGroup)
   * - {session_id} - Session ID (if available)
   * - {worktree_id} - Worktree ID (if available)
   *
   * The template command receives JSON payload via stdin and should pipe it
   * to `agor-executor --stdin`.
   *
   * @example Kubernetes execution
   * ```yaml
   * executor_command_template: |
   *   kubectl run executor-{task_id} \
   *     --image=ghcr.io/preset-io/agor-executor:latest \
   *     --rm -i --restart=Never \
   *     --overrides='{
   *       "spec": {
   *         "securityContext": {
   *           "runAsUser": {unix_user_uid},
   *           "fsGroup": {unix_user_gid}
   *         }
   *       }
   *     }' \
   *     -- agor-executor --stdin
   * ```
   *
   * @example Docker execution
   * ```yaml
   * executor_command_template: |
   *   docker run --rm -i \
   *     --user {unix_user_uid}:{unix_user_gid} \
   *     -v /data/agor:/data/agor \
   *     ghcr.io/preset-io/agor-executor:latest \
   *     agor-executor --stdin
   * ```
   */
  executor_command_template?: string;

  /**
   * Required user environment variables.
   * When set, prompts are blocked if any listed var is missing from the user's resolved environment.
   * Users are directed to Settings → Environment Variables to configure them.
   * Default: unset (no enforcement)
   *
   * @example Require git identity for proper commit attribution
   * ```yaml
   * execution:
   *   required_user_env_vars:
   *     - GIT_AUTHOR_NAME
   *     - GIT_AUTHOR_EMAIL
   *     - GIT_COMMITTER_NAME
   *     - GIT_COMMITTER_EMAIL
   * ```
   */
  required_user_env_vars?: string[];

  /**
   * Minimum role required to *trigger* managed environment commands
   * (start/stop/nuke/logs) for a worktree.
   *
   * - `'none'` — disables triggers for everyone (kill switch; authoring is still allowed)
   * - `'viewer'` — any authenticated user
   * - `'member'` — default; members and above
   * - `'admin'` — admins and superadmins only
   * - `'superadmin'` — superadmins only
   *
   * Default: `'member'`.
   *
   * Note: *authoring* env commands (`start_command`, `stop_command`, …, or
   * `environment_config` on repos) is always gated to admins via
   * `requireAdminForEnvConfig`. This flag is orthogonal and controls who can
   * *trigger* those admin-authored commands.
   *
   * Worktree-level RBAC (`others_can` on each worktree) still applies on top
   * of this flag when `worktree_rbac: true`.
   */
  managed_envs_minimum_role?: ManagedEnvsMinimumRole;
}

/**
 * Security headers & CORS settings.
 *
 * Makes the daemon's Content-Security-Policy and CORS policy tunable from
 * `~/.agor/config.yaml` without code changes. See `context/concepts/security.md`
 * for the full model and the rationale behind the two-tier CSP shape.
 */

/**
 * Per-directive CSP source lists, keyed by the standard directive names.
 *
 * Keys must be lowercase-hyphenated directive names (e.g. `script-src`,
 * `frame-src`, `connect-src`). Values are arrays of CSP source expressions
 * (`'self'`, `'unsafe-inline'`, URLs, schemes, nonces, etc.). The loader
 * rejects unknown directive names with a friendly error.
 */
export type AgorCspDirectives = Record<string, string[]>;

/**
 * CSP configuration.
 *
 * Two-tier model:
 *   - `extras`: append to built-in defaults (append-only, 95% case)
 *   - `override`: fully replace a directive's source list (escape hatch)
 *
 * Setting a directive in `override` causes defaults AND extras for that
 * directive to be ignored — `override` is authoritative per-directive.
 *
 * Examples:
 * ```yaml
 * security:
 *   csp:
 *     extras:
 *       script-src: ["https://plausible.io"]
 *       frame-src: ["https://my-sandbox.example.com"]
 *     override:
 *       img-src: ["'self'", "data:"]
 * ```
 */
export interface AgorCspSettings {
  /**
   * Per-directive APPEND to built-in defaults. This is the 95% case.
   * Entries are merged and de-duplicated with the built-in default sources.
   */
  extras?: AgorCspDirectives;

  /**
   * Full replacement of a directive's source list. Escape hatch — rarely needed.
   * Setting a directive here ignores defaults AND extras for that directive.
   */
  override?: AgorCspDirectives;

  /**
   * Path (or absolute URL) that receives CSP violation reports. When set:
   *   - emits the `report-uri` directive on the CSP header (deprecated but
   *     still supported by all browsers)
   *   - emits a `Report-To` header pointing at the same path (modern browsers)
   *   - the daemon hosts a rate-limited endpoint at this path that logs
   *     incoming reports at `warn` level.
   * @example "/api/csp-report"
   */
  report_uri?: string;

  /**
   * Emit as `Content-Security-Policy-Report-Only` instead of enforcing.
   * Useful for iterating on policy without breaking the app.
   * Default: false.
   */
  report_only?: boolean;

  /**
   * Fully disable the CSP header. Dev/debug only — the daemon emits a loud
   * startup warning when this is true. Default: false.
   */
  disabled?: boolean;
}

/**
 * How CORS origins are resolved.
 *
 * - `list` (default): only origins in `origins` are allowed (plus built-ins:
 *   localhost, Sandpack if enabled, GitHub Codespaces if detected).
 * - `wildcard`: reflect ANY origin. Forces `credentials: false`. Dangerous
 *   outside of local dev; the daemon refuses to boot in hardened deployment
 *   modes when this is set.
 * - `reflect`: echo the request's `Origin` header back as the allowed origin.
 *   Less permissive than wildcard for caches (Vary: Origin), but still permits
 *   any caller — treat it like wildcard for threat-model purposes.
 * - `null-origin`: allow the literal `Origin: null` header (sandboxed iframes,
 *   file:// documents). Rarely needed.
 */
export type AgorCorsMode = 'list' | 'wildcard' | 'reflect' | 'null-origin';

/**
 * CORS configuration.
 *
 * Supersedes the legacy `daemon.cors_origins` and `daemon.cors_allow_sandpack`
 * keys. Those still work for backwards compatibility — their values are merged
 * in when `security.cors.origins` is absent — but they emit a deprecation
 * warning at startup. The `CORS_ORIGIN` env var continues to win over all
 * config sources to keep existing deployments working.
 */
export interface AgorCorsSettings {
  /**
   * Origin resolution strategy. Defaults to `list`.
   */
  mode?: AgorCorsMode;

  /**
   * Exact origins or `/regex/` patterns to allow (used when `mode: list`).
   * Plain strings are exact matches; wrap in `/slashes/` for regex.
   */
  origins?: string[];

  /**
   * Whether to emit `Access-Control-Allow-Credentials: true`. Default: true.
   * Rejected at config load when combined with `mode: wildcard` or `reflect`
   * (the CORS spec forbids credentialed wildcard reflection).
   */
  credentials?: boolean;

  /**
   * Allowed methods. Defaults to the `cors` package's default set.
   */
  methods?: string[];

  /**
   * Allowed request headers. When omitted, the `cors` package reflects
   * `Access-Control-Request-Headers` (its default behaviour).
   */
  allowed_headers?: string[];

  /**
   * Value for the `Access-Control-Max-Age` preflight cache header, in seconds.
   * Default: unset (leaves it to the `cors` package default, usually 5s).
   */
  max_age_seconds?: number;

  /**
   * Allow Sandpack/CodeSandbox bundler origins (`https://*.codesandbox.io`).
   * Defaults to true so first-party artifacts work out of the box.
   */
  allow_sandpack?: boolean;
}

/**
 * Top-level security config block.
 */
export interface AgorSecuritySettings {
  /** Content-Security-Policy configuration (extras/override/report-only/disabled). */
  csp?: AgorCspSettings;

  /** CORS configuration (origins, credentials, methods, headers, max-age). */
  cors?: AgorCorsSettings;
}

/**
 * Path configuration settings
 *
 * Allows separation of daemon operating files from git data files.
 * This enables different storage backends (e.g., local SSD for daemon, EFS for worktrees).
 *
 * @see context/explorations/executor-expansion.md
 */
export interface AgorPathSettings {
  /**
   * Git data directory (repos, worktrees)
   *
   * When set, repos and worktrees are stored here instead of under agor_home.
   * Useful for k8s deployments where worktrees need to be on shared storage (EFS).
   *
   * Default: same as agor_home (~/.agor)
   *
   * Environment variable: AGOR_DATA_HOME (takes precedence over config)
   *
   * @example
   * ```yaml
   * paths:
   *   data_home: /data/agor
   * ```
   */
  data_home?: string;
}

/**
 * Supported credential keys (enum for type safety)
 */
export enum CredentialKey {
  ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY',
  ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN',
  ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL',
  OPENAI_API_KEY = 'OPENAI_API_KEY',
  GEMINI_API_KEY = 'GEMINI_API_KEY',
  COPILOT_GITHUB_TOKEN = 'COPILOT_GITHUB_TOKEN',
}

/**
 * Tool credentials (API keys, tokens, etc.)
 */
export interface AgorCredentials {
  /** Anthropic API key for Claude Code */
  ANTHROPIC_API_KEY?: string;

  /** Anthropic auth token for proxy/enterprise setups (alternative to API key)
   * Used by Claude Code SDK for token-based authentication (e.g., AWS Bedrock, OAuth proxies) */
  ANTHROPIC_AUTH_TOKEN?: string;

  /** Custom Anthropic API base URL (default: https://api.anthropic.com)
   * Useful for proxies, Claude Enterprise deployments, or third-party compatible APIs */
  ANTHROPIC_BASE_URL?: string;

  /** OpenAI API key for Codex */
  OPENAI_API_KEY?: string;

  /** Google Gemini API key */
  GEMINI_API_KEY?: string;

  /** GitHub token for Copilot */
  COPILOT_GITHUB_TOKEN?: string;
}

/**
 * Onboarding settings (stored by CLI init, consumed by UI wizard)
 */
export interface AgorOnboardingSettings {
  /** Whether assistant setup was requested during init */
  assistantPending?: boolean;
  /** @deprecated Use assistantPending instead */
  persistedAgentPending?: boolean;
  /** Clone URL for the framework repo */
  frameworkRepoUrl?: string;
}

/**
 * Worktree-level defaults.
 *
 * Top-level `worktrees:` section (not under `execution:`) because these
 * settings shape *how worktrees are created*, not how sessions execute.
 * Ignored when `execution.worktree_rbac: false` (open-access mode has no
 * per-worktree ACL to default).
 */
export interface AgorWorktreesSettings {
  /**
   * Default value for a new worktree's `others_can` when the caller doesn't
   * specify one. Controls what non-owners can do on the worktree.
   *
   * - `'none'`  — private to owners
   * - `'view'`  — read-only access
   * - `'session'` (default) — can create own sessions
   * - `'prompt'` — can prompt others' sessions (inherits their OS identity)
   * - `'all'`   — full control
   *
   * Default: `'session'` (matches current repository-layer default).
   */
  others_can_default?: WorktreePermissionLevel;

  /**
   * Default filesystem access tier for non-owners on new worktrees.
   * Only meaningful in `unix_user_mode: insulated` or `strict`.
   *
   * - `'none'`  — no filesystem access
   * - `'read'`  (default) — read-only via worktree group
   * - `'write'` — full write access via worktree group
   */
  others_fs_access_default?: 'none' | 'read' | 'write';
}

/**
 * Complete Agor configuration
 */
export interface AgorConfig {
  /** Global defaults */
  defaults?: AgorDefaults;

  /** Display settings */
  display?: AgorDisplaySettings;

  /** Daemon settings */
  daemon?: AgorDaemonSettings;

  /** UI settings */
  ui?: AgorUISettings;

  /** Database configuration */
  database?: AgorDatabaseSettings;

  /** OpenCode.ai integration settings */
  opencode?: AgorOpenCodeSettings;

  /** Codex-specific configuration */
  codex?: AgorCodexSettings;

  /** Execution isolation settings */
  execution?: AgorExecutionSettings;

  /** Security headers & CORS (CSP extras/override, CORS mode/origins, etc.) */
  security?: AgorSecuritySettings;

  /** Worktree-level defaults (others_can_default, others_fs_access_default) */
  worktrees?: AgorWorktreesSettings;

  /** Path configuration (data_home for repos/worktrees separation) */
  paths?: AgorPathSettings;

  /** Tool credentials (API keys, tokens) */
  credentials?: AgorCredentials;

  /** Onboarding settings (CLI init → UI wizard) */
  onboarding?: AgorOnboardingSettings;

  /** Declarative resource definitions for headless/k8s deployments */
  resources?: DaemonResourcesConfig;

  /**
   * Service tier configuration for lean daemon mode.
   *
   * Controls which FeathersJS service groups are registered and how they're exposed.
   * Each group can be: 'off' | 'internal' | 'readonly' | 'on' (default: 'on').
   *
   * @example Executor pod config
   * ```yaml
   * services:
   *   core: on
   *   worktrees: on
   *   repos: readonly
   *   users: internal
   *   boards: off
   *   cards: off
   * ```
   */
  services?: import('../types/config-services').DaemonServicesConfig;
}

/**
 * Valid config keys (includes nested keys with dot notation)
 */
export type ConfigKey =
  | `defaults.${keyof AgorDefaults}`
  | `display.${keyof AgorDisplaySettings}`
  | `daemon.${keyof AgorDaemonSettings}`
  | `ui.${keyof AgorUISettings}`
  | `database.${keyof AgorDatabaseSettings}`
  | `opencode.${keyof AgorOpenCodeSettings}`
  | `codex.${keyof AgorCodexSettings}`
  | `execution.${keyof AgorExecutionSettings}`
  | `security.${keyof AgorSecuritySettings}`
  | `worktrees.${keyof AgorWorktreesSettings}`
  | `paths.${keyof AgorPathSettings}`
  | `credentials.${keyof AgorCredentials}`
  | `onboarding.${keyof AgorOnboardingSettings}`
  | `services.${keyof import('../types/config-services').DaemonServicesConfig}`;
