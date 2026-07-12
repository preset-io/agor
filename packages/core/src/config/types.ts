/**
 * Agor Configuration Types
 */

import type { ManagedEnvExecutionMode } from '../environment/webhook';
import type { BranchPermissionLevel } from '../types/branch';
import type { UserRole } from '../types/user';

export type { ManagedEnvExecutionMode };
export type ManagedEnvsExecutionMode = ManagedEnvExecutionMode;

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

  /** JWT secret (auto-generated if not provided) */
  jwtSecret?: string;

  /** Master secret for API key encryption (auto-generated if not provided) */
  masterSecret?: string;

  /** Enable built-in MCP server (default: true) */
  mcpEnabled?: boolean;

  /** Enable tool search mode: tools/list returns only essential tools,
   *  agents discover others via agor_search_tools (default: true) */
  mcpToolSearch?: boolean;

  /** Unix user the daemon runs as. Used to refresh supplemental Unix groups.
   * Required when Unix impersonation/isolation is enabled (`unix_user_mode`
   * is `insulated` or `strict`). App-level `branch_rbac` alone does not
   * require Unix impersonation. In dev mode without isolation, falls back to
   * current process user. */
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
  /**
   * Public user-facing base URL for the UI.
   *
   * Legacy/compatibility alias for daemon.base_url in older configs. New
   * installs should prefer daemon.base_url so all external link builders share
   * one setting.
   */
  base_url?: string;

  /** UI dev server port (default: 5173) */
  port?: number;

  /** UI host (default: localhost) */
  host?: string;
}

/**
 * Generic one-time launch-code authentication handoff.
 *
 * A trusted external launch issuer opens the runtime UI with an opaque,
 * short-lived code. The daemon exchanges that code over a server-to-server
 * backchannel, verifies the returned assertion, maps a local user, and issues
 * normal runtime auth tokens.
 */
export interface AgorExternalLaunchSettings {
  /** Enable POST /auth/launch (default: false). */
  enabled?: boolean;

  /** Server-to-server exchange endpoint that consumes one-time launch codes. */
  exchange_url?: string;

  /** Expected JWT issuer for returned launch assertions. */
  issuer?: string;

  /** Expected JWT audience for returned launch assertions; identifies this runtime. */
  audience?: string;

  /** Optional runtime instance identifier required to match assertion instance_id/runtime_instance_id. */
  instance_id?: string;

  /** Stable provider label used in local external identity mapping. Defaults to issuer. */
  provider_id?: string;

  /** JWKS endpoint used to verify returned launch assertions. */
  jwks_url?: string;

  /** PEM public key used to verify returned launch assertions. */
  public_key?: string;

  /** Dev-only symmetric key used to verify HS256 launch assertions. Prefer JWKS/public_key. */
  dev_shared_secret?: string;

  /** Environment variable that contains the dev-only symmetric key. */
  dev_shared_secret_env?: string;

  /** Bearer credential sent by the daemon to the exchange endpoint. Prefer service_credential_env. */
  service_credential?: string;

  /** Environment variable that contains the exchange endpoint bearer credential. */
  service_credential_env?: string;

  /** Backchannel request timeout in milliseconds (default: 10000). */
  request_timeout_ms?: number;

  /** Optional allow-list of JWT algorithms for returned launch assertions. */
  algorithms?: string[];

  /** Allow launch assertions to assign admin/superadmin roles (default: false). */
  allow_admin_roles?: boolean;

  /**
   * Trust a verified assertion email when linking launch auth to an existing
   * local user that does not yet have this provider identity recorded.
   */
  trust_verified_email_for_linking?: boolean;

  /**
   * Optional HTTP(S) URL shown in the unauthenticated UI when external launch
   * sign-in is unavailable, missing, expired, or invalid.
   */
  login_redirect_url?: string;
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
 * Unix user isolation mode controlling how session processes get mapped to
 * OS identities.
 *
 * - `simple` — all processes run as the daemon user (no OS isolation)
 * - `insulated` — executors run as a dedicated user with per-branch groups
 * - `strict` — sessions run as the session creator's own Unix user
 */
export type UnixUserMode = 'simple' | 'insulated' | 'strict';

export interface AgorExecutorHeartbeatSettings {
  /** Enable executor task heartbeats (default: true). */
  enabled?: boolean;

  /** Heartbeat interval in milliseconds (default: 10000). */
  interval_ms?: number;

  /** Stale threshold in milliseconds. Default: max(3 * interval_ms, 30000). */
  stale_after_ms?: number | null;

  /** Optional external command callback invoked on each heartbeat. */
  callback?: {
    /** Shell command to run. Receives heartbeat JSON on stdin. Disabled when null/undefined. */
    command_template?: string | null;
    /** Callback timeout in milliseconds (default: 3000). */
    timeout_ms?: number;
  };
}

/**
 * Execution settings
 */
export interface AgorExecutionSettings {
  /**
   * Lightweight heartbeat settings for long-running executor tasks.
   *
   * The executor patches `tasks.last_executor_heartbeat_at` immediately and
   * then every `interval_ms` while a task is active. The daemon may mark stale
   * active tasks failed after `stale_after_ms` without retrying automatically.
   * Optional callbacks are shell commands that receive a small JSON payload on
   * stdin; keep secrets out of the command argv.
   */
  executor_heartbeat?: AgorExecutorHeartbeatSettings;

  /** Unix user to run executors as (default: undefined = run as daemon user). When set, uses sudo impersonation. */
  executor_unix_user?: string;

  /** Unix user mode: simple (no isolation), insulated (branch groups), strict (enforce process impersonation) */
  unix_user_mode?: UnixUserMode;

  /** Enable branch RBAC and ownership system (default: false). When enabled, enforces permission checks and Unix group isolation. */
  branch_rbac?: boolean;

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
   * Branch-level permissions still apply: opening a terminal against a
   * branch requires at least `session` permission on that branch.
   */
  allow_web_terminal?: boolean;

  /** Allow superadmin role (default: false). When true, superadmin role gets branch RBAC bypass. Opt-in for self-hosted deployments. */
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

  /**
   * When true (default), the daemon writes the initial user-message row inside
   * `POST /sessions/:id/prompt`, immediately after the task is created. This
   * guarantees the chat transcript reflects what the user typed even if the
   * executor crashes during startup ("never lose a prompt").
   *
   * Set to false to revert to the legacy behavior where the executor is the
   * sole writer of the user-message row. The legacy behavior is racy: any
   * crash before the executor connects back via Feathers leaves the prompt
   * visible only on `tasks.full_prompt`, not in the chat transcript.
   *
   * Kill switch only — intended for emergency rollback. The executor's
   * `createUserMessage` path always honors a "skip if user-message row already
   * exists for this task" guard, so toggling this flag is safe at runtime.
   */
  daemon_writes_user_message?: boolean;

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
   * - {branch_id} - Branch ID (if available)
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
   * (start/stop/nuke/logs) for a branch.
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
   * Branch-level RBAC (`others_can` on each branch) still applies on top
   * of this flag when `branch_rbac: true`.
   */
  managed_envs_minimum_role?: ManagedEnvsMinimumRole;

  /**
   * Managed environment lifecycle execution policy.
   *
   * - `'hybrid'` — default/backwards-compatible mode. Rendered lifecycle
   *   fields run as shell commands, except fields that are explicit `http://`
   *   or `https://` URLs are invoked as GET webhooks.
   * - `'webhook-only'` — lockdown mode for deployments that must not let
   *   `.agor.yml` run arbitrary shell/Docker/Kubernetes commands through Agor.
   *   `start`, `stop`, `nuke`, and `logs` must render to HTTP(S) URLs.
   *
   * Server policy wins over repo-authored `.agor.yml`: a repo cannot opt out
   * of webhook-only mode.
   *
   * Default: `'hybrid'`.
   */
  managed_envs_execution_mode?: ManagedEnvsExecutionMode;

  /**
   * Branch storage configuration — operator gate for which storage modes a
   * branch can be created with. The API/UI/MCP `storage_mode` field is
   * always exposed (stable shape), but requests for a mode not listed in
   * `allowed_modes` are rejected at the daemon service boundary with a
   * clear "enable it in config" error.
   *
   * v0.20+ default already allows both `worktree` and `clone` with
   * `default_mode: worktree`, so this block is only needed when an
   * operator wants to deviate. See `context/explorations/clone-redesign.md`
   * for the storage-model design.
   *
   * @example Disable clone mode entirely (security-gradient deployment)
   * ```yaml
   * execution:
   *   branch_storage:
   *     allowed_modes:
   *       - worktree
   * ```
   *
   * @example Make clone the default backing for new branches
   * ```yaml
   * execution:
   *   branch_storage:
   *     default_mode: clone
   *     allowed_modes:
   *       - worktree
   *       - clone
   * ```
   */
  branch_storage?: AgorBranchStorageSettings;
}

/**
 * Storage model for a branch's filesystem.
 *
 * - `'worktree'` — native `git worktree add` (shared base `.git/config`,
 *   legacy default).
 * - `'clone'` — self-standing `git clone` with its own `.git/` directory;
 *   closes cross-branch credential/config leak vectors.
 */
export const BRANCH_STORAGE_MODES = ['worktree', 'clone'] as const;
export type BranchStorageMode = (typeof BRANCH_STORAGE_MODES)[number];
export const DEFAULT_BRANCH_STORAGE_MODE: BranchStorageMode = 'worktree';

export interface ResolvedBranchStorageConfig {
  defaultMode: BranchStorageMode;
  allowedModes: readonly BranchStorageMode[];
}

/**
 * Operator gate for which storage modes can be selected at branch-create
 * time. Defaults (v0.20+) enable both modes so users can pick per branch;
 * `default_mode` stays on `'worktree'` for backwards compatibility. Pin
 * `allowed_modes: ['worktree']` to disable clone mode entirely (e.g. for
 * security gradient reasons).
 */
export interface AgorBranchStorageSettings {
  /**
   * Mode used when a create request doesn't specify one. Must also appear
   * in `allowed_modes`. Default: `'worktree'`.
   */
  default_mode?: BranchStorageMode;

  /**
   * Storage modes the operator has enabled for this instance. Requests for
   * a mode not in this list are rejected. Default: `['worktree', 'clone']`
   * — both modes selectable from the UI / MCP tool out of the box.
   */
  allowed_modes?: BranchStorageMode[];
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
 *   localhost, Sandpack if enabled).
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
 * `security.git_config_parameters` shape. Mirrors `security.csp`: `extras`
 * appends to safe defaults, `override` replaces them. Mutually exclusive.
 *
 * Defaults + rationale: `docs/internal/credential-leak-defenses-2026-05-11.md`.
 * Don't bake credential-bearing values (e.g. `http.proxy=http://user:pass@…`)
 * here — the daemon redacts them from logs but the env var itself isn't
 * routed through the encrypted env-file path.
 */
export interface AgorGitConfigParametersSettings {
  extras?: string[];
  override?: string[];
}

/**
 * Top-level security config block.
 */
export interface AgorSecuritySettings {
  /** Content-Security-Policy configuration (extras/override/report-only/disabled). */
  csp?: AgorCspSettings;

  /** CORS configuration (origins, credentials, methods, headers, max-age). */
  cors?: AgorCorsSettings;

  /** Git config hardening — see {@link AgorGitConfigParametersSettings}. */
  git_config_parameters?: AgorGitConfigParametersSettings;
}

/**
 * Path configuration settings
 *
 * Allows separation of daemon operating files from git data files.
 * This enables different storage backends (e.g., local SSD for daemon, EFS for branches).
 *
 * @see context/explorations/executor-expansion.md
 */
export interface AgorPathSettings {
  /**
   * Git data directory (repos, branches)
   *
   * When set, repos and branches are stored here instead of under agor_home.
   * Useful for k8s deployments where branches need to be on shared storage (EFS).
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
 * Public open-source telemetry settings.
 *
 * This is intentionally separate from `analytics`: `analytics` is for
 * operator-configured instance analytics, while `telemetry` is Agor's
 * lightweight opt-in/open-source install and aggregate usage telemetry.
 */
export interface AgorTelemetrySettings {
  /** Ongoing telemetry opt-in. Undefined means the user has not answered yet. */
  enabled?: boolean;

  /** Random anonymous install identifier. Never derived from host/user data. */
  instance_id?: string;

  /** Advanced override for the Segment-compatible batch endpoint. Usually omitted. */
  endpoint?: string | null;

  /** Advanced override for direct Segment/RudderStack delivery. Usually omitted. */
  write_key?: string | null;

  /** Debug delivery without dumping payloads by default. */
  debug?: boolean;

  /** Delivery timeout. Defaults to 3000ms. */
  timeout_ms?: number;

  /** Batch flush interval. Defaults to 1000ms. */
  flush_interval_ms?: number;

  /** Maximum events per batch. Defaults to 10. */
  max_batch_size?: number;

  /** Last one-time install/result telemetry event sent by agor init. */
  install_ping_sent_at?: string;

  /** Last daemon active heartbeat day (YYYY-MM-DD). */
  last_daemon_active_day?: string;

  /** Last aggregate usage summary day (YYYY-MM-DD). */
  last_usage_summary_day?: string;

  /** Last daemon version that emitted daemon.upgraded. */
  last_reported_version?: string;
}

/**
 * Backend analytics settings.
 *
 * Disabled by default. When enabled, daemon/server code sends curated
 * lifecycle events through a central analytics client. Plugin configuration is
 * resolved by type at daemon startup.
 */
export interface AgorAnalyticsSettings {
  /** Master kill-switch. Defaults to false. */
  enabled?: boolean;

  /** Static client options passed to the underlying analytics package. */
  client?: {
    app?: string;
    version?: string | number;
    debug?: boolean;
  };

  /** Simple event-name filters. */
  filters?: {
    /** Exact names or simple `*` globs to exclude before delivery. */
    exclude_events?: string[];
  };

  /** Analytics delivery plugins. */
  plugins?: AgorAnalyticsPluginSettings[];
}

export type AgorAnalyticsPluginSettings =
  | AgorAnalyticsStdoutPluginSettings
  | AgorAnalyticsHttpBatchPluginSettings
  | AgorAnalyticsModulePluginSettings;

export interface AgorAnalyticsStdoutPluginSettings {
  type: 'stdout';
  enabled?: boolean;
  options?: {
    /** Pretty-print JSON instead of emitting JSON lines. Defaults to false. */
    pretty?: boolean;
  };
}

export interface AgorAnalyticsHttpBatchPluginSettings {
  type: 'http_batch';
  enabled?: boolean;
  options?: {
    /** Destination URL. Required when this plugin is enabled. */
    url?: string | null;
    flush_interval_ms?: number;
    max_batch_size?: number;
    timeout_ms?: number;
    /** Static headers only. */
    headers?: Record<string, string>;
  };
}

export interface AgorAnalyticsModulePluginSettings {
  type: 'module';
  enabled?: boolean;
  options?: {
    /** Package name or absolute local module path to dynamically import. */
    module_path?: string | null;
    /** Factory export to call. Defaults to createAnalyticsPlugin. */
    export_name?: string;
    /** Passed as the first argument to the module factory. */
    plugin_options?: Record<string, unknown>;
  };
}

/**
 * Onboarding settings (consumed by UI wizard; may be set by existing installs)
 */
export interface AgorOnboardingSettings {
  /** Whether AI teammate setup is pending (canonical key consumed by UI wizard) */
  teammatePending?: boolean;
  /** @deprecated Use teammatePending. Read for pre-rename config compatibility only. */
  assistantPending?: boolean;
  /** @deprecated Use teammatePending. Read for pre-rename config compatibility only. */
  persistedAgentPending?: boolean;
  /** Clone URL for the framework repo */
  frameworkRepoUrl?: string;
}

/**
 * Branch-level defaults.
 *
 * Top-level `branches:` section (not under `execution:`) because these
 * settings shape *how branches are created*, not how sessions execute.
 * Ignored when `execution.branch_rbac: false` (open-access mode has no
 * per-branch ACL to default).
 */
export interface AgorBranchesSettings {
  /**
   * Default value for a new branch's `others_can` when the caller doesn't
   * specify one. Controls what non-owners can do on the branch.
   *
   * - `'none'`  — private to owners
   * - `'view'`  — read-only access
   * - `'session'` (default) — can create own sessions
   * - `'prompt'` — can prompt others' sessions (inherits their OS identity)
   * - `'all'`   — full control
   *
   * Default: `'session'` (matches current repository-layer default).
   */
  others_can_default?: BranchPermissionLevel;

  /**
   * Default filesystem access tier for non-owners on new branches.
   * Only meaningful in `unix_user_mode: insulated` or `strict`.
   *
   * - `'none'`  — no filesystem access
   * - `'read'`  (default) — read-only via branch group
   * - `'write'` — full write access via branch group
   */
  others_fs_access_default?: 'none' | 'read' | 'write';
}

/**
 * Per-vendor HTTP proxy configuration.
 *
 * Mounts a thin pass-through proxy at `/proxies/<vendor>/...` that forwards
 * bytes to `upstream/...`. Designed to let Sandpack artifacts call third-party
 * REST APIs that don't return CORS headers (Shortcut, Linear, Jira, etc.).
 *
 * Hard rules:
 *  - Pass-through bytes only — no transformation, no caching, no auth injection.
 *  - Read-only by default — `allowed_methods` defaults to `['GET']`.
 *  - Off by default — when no `proxies:` block is configured, the route is
 *    not mounted at all.
 */
export interface AgorProxyConfig {
  /**
   * Bare scheme+host of the upstream API (no path prefix).
   *
   * Convention: `https://api.app.shortcut.com`, NOT
   * `https://api.app.shortcut.com/api/v3`. The caller specifies the path
   * tail. Must be `https://` — `http://` upstreams are rejected at startup.
   */
  upstream: string;

  /** Optional human-readable label, surfaced in MCP discovery and docs. */
  description?: string;

  /** Optional link to the upstream's developer documentation. */
  docs_url?: string;

  /**
   * HTTP methods the proxy will accept for this vendor. Defaults to `['GET']`
   * (read-only-by-default rule). Operators opt into writes per vendor.
   */
  allowed_methods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'>;
}

/**
 * Knowledge Base semantic search settings. Secrets are stored separately in the
 * encrypted app_variables table; this config only carries non-secret defaults.
 */
export interface AgorKnowledgeSettings {
  semantic_search?: {
    enabled?: boolean;
    provider?: 'openai' | 'voyage' | 'openai-compatible';
    model?: string;
    dimensions?: number;
    chunking?: {
      target_tokens?: number;
      max_tokens?: number;
      overlap_tokens?: number;
      min_tokens?: number;
    };
    indexing?: {
      paused?: boolean;
      batch_size?: number;
      concurrency?: number;
    };
  };
}

/**
 * App-level multi-tenancy settings.
 *
 * `static` preserves today's single-tenant behavior: every request belongs to
 * one configured tenant id. `required_from_auth` is Postgres-only hosted/cloud
 * mode and must resolve a tenant from trusted authentication or request
 * context; missing tenant context should fail closed before tenant-owned data is
 * accessed.
 */
export interface AgorMultiTenancySettings {
  /** Multi-tenancy mode. Defaults to `static`. */
  mode?: 'static' | 'required_from_auth';

  /** Static tenant id for self-hosted/single-instance mode. Defaults to `default`. */
  static_tenant_id?: string;

  /** JWT/user claim name to read in `required_from_auth` mode, e.g. `tenant_id`. */
  auth_claim?: string;

  /** Optional trusted HTTP header set by an auth/edge layer, e.g. `x-agor-tenant-id`. */
  trusted_header?: string;
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

  /** Generic external one-time launch-code authentication. */
  external_launch?: AgorExternalLaunchSettings;

  /** Execution isolation settings */
  execution?: AgorExecutionSettings;

  /** Security headers & CORS (CSP extras/override, CORS mode/origins, etc.) */
  security?: AgorSecuritySettings;

  /** Branch-level defaults (others_can_default, others_fs_access_default) */
  branches?: AgorBranchesSettings;

  /** Path configuration (data_home for repos/branches separation) */
  paths?: AgorPathSettings;

  /** Backend analytics settings. Disabled by default. */
  analytics?: AgorAnalyticsSettings;

  /** Public open-source telemetry settings. */
  telemetry?: AgorTelemetrySettings;

  /** Knowledge Base semantic search settings. */
  knowledge?: AgorKnowledgeSettings;

  /** Onboarding settings (CLI init → UI wizard) */
  onboarding?: AgorOnboardingSettings;

  /** App-level multi-tenancy settings. Defaults to static/default tenant. */
  multi_tenancy?: AgorMultiTenancySettings;

  /**
   * HTTP proxy passthroughs for third-party APIs that don't return CORS
   * headers (Shortcut, Linear, Jira, etc.). Keyed by vendor slug used in
   * the route path: `/proxies/<vendor>/...`.
   *
   * Off by default: omit this block to disable the feature entirely.
   * See `apps/agor-docs/pages/guide/api-proxies.mdx`.
   */
  proxies?: Record<string, AgorProxyConfig>;
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
  | `external_launch.${keyof AgorExternalLaunchSettings}`
  | `execution.${keyof AgorExecutionSettings}`
  | `security.${keyof AgorSecuritySettings}`
  | `branches.${keyof AgorBranchesSettings}`
  | `paths.${keyof AgorPathSettings}`
  | `analytics.${keyof AgorAnalyticsSettings}`
  | `telemetry.${keyof AgorTelemetrySettings}`
  | `knowledge.${keyof AgorKnowledgeSettings}`
  | `onboarding.${keyof AgorOnboardingSettings}`;
