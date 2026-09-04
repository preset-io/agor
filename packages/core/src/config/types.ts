/**
 * Agor Configuration Types
 */

import type { InstallableAgenticTool } from '../agentic-integrations';
import type { ManagedEnvExecutionMode } from '../environment/webhook';
import type { AgorPasswordPolicyProfile } from './password-policy';

export type { ManagedEnvExecutionMode };
export type ManagedEnvsExecutionMode = ManagedEnvExecutionMode;

/** Deployment-owned agentic-tool package selection. */
export interface AgorAgenticToolsSettings {
  /** Integrations that must match the running Agor version exactly. */
  installed?: InstallableAgenticTool[];

  /**
   * Enable daemon-driven Claude subscription OAuth after the operator has an
   * authorized provider/client contract. Default: false.
   */
  claude_subscription_oauth?: boolean;
}

/**
 * Type for user-provided JSON data where structure is unknown or dynamic
 *
 * Use this instead of `any` when dealing with user input or dynamic data structures.
 */
// biome-ignore lint/suspicious/noExplicitAny: Escape hatch for user-provided JSON data
export type UnknownJson = any;

/**
 * Daemon settings
 */
export interface AgorDaemonSettings {
  /** Stable identity shared by every process belonging to this deployment. */
  deployment_id?: string;

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
   * Browser-reachable base URL for daemon endpoints.
   *
   * Used for OAuth callbacks and artifact API grants. It is also the fallback
   * origin for browser UI links when ui.base_url is not set.
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
   * Set this when the browser UI is served from a different origin than the
   * daemon, such as the two-process development setup. When omitted, browser
   * links fall back to daemon.base_url. It also remains a compatibility
   * fallback for older one-origin installations.
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

  /** Backchannel request timeout in milliseconds, from 1 to 120000 (default: 10000). */
  request_timeout_ms?: number;

  /** Optional non-empty allow-list of supported JWT algorithms for returned assertions. */
  algorithms?: AgorExternalLaunchAlgorithm[];

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

  /**
   * Forward the normalized inbound browser Host to the exchange endpoint as an
   * opaque `request_host` field. Enable when the launch issuer binds a code to
   * the exact route the browser entered (host-bound launch). Default: false.
   *
   * The value is read from a trusted local request header — never from an
   * arbitrary client-supplied body field — so the daemon cannot be tricked into
   * presenting a code minted for one host through a different host.
   */
  forward_request_host?: boolean;

  /**
   * Request header the daemon reads the normalized browser Host from when
   * `forward_request_host` is enabled. The trusted proxy / edge in front of the
   * daemon owns host normalization and must overwrite this header. Default:
   * `host`. Set to e.g. `x-forwarded-host` only when a trusted edge sets it.
   */
  trusted_host_header?: string;

  /**
   * Query parameter appended to `login_redirect_url` carrying the current
   * browser host as an opaque return context, so a direct visit to a workspace
   * host that has no local session can start the issuer's launch-init flow and
   * be returned to the exact host it came from. The issuer must allow-list this
   * value against its own routing records. Default: `return_host`.
   *
   * Must not be `return_to`: that name is reserved for the relative deep-link
   * the UI forwards to the launch-init endpoint, and reusing it would overwrite
   * the deep-link with the host. Rejected during config validation.
   */
  return_host_param?: string;
}

/** Algorithms accepted by the launch assertion verifier. `none` is never valid. */
export const AgorExternalLaunchAlgorithm = {
  HS256: 'HS256',
  HS384: 'HS384',
  HS512: 'HS512',
  RS256: 'RS256',
  RS384: 'RS384',
  RS512: 'RS512',
  ES256: 'ES256',
  ES384: 'ES384',
  ES512: 'ES512',
  PS256: 'PS256',
  PS384: 'PS384',
  PS512: 'PS512',
} as const;
export type AgorExternalLaunchAlgorithm =
  (typeof AgorExternalLaunchAlgorithm)[keyof typeof AgorExternalLaunchAlgorithm];

/** Which system may create and remove user projections in this daemon. */
export const AgorUserLifecycleAuthority = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
} as const;
export type AgorUserLifecycleAuthority =
  (typeof AgorUserLifecycleAuthority)[keyof typeof AgorUserLifecycleAuthority];

/** Which system owns the effective Agor role. */
export const AgorRoleAuthority = {
  INTERNAL: 'internal',
  CLAIMS: 'claims',
} as const;
export type AgorRoleAuthority = (typeof AgorRoleAuthority)[keyof typeof AgorRoleAuthority];

/** Whether password-based authentication is available on this daemon. */
export const AgorLocalAuthMode = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
} as const;
export type AgorLocalAuthMode = (typeof AgorLocalAuthMode)[keyof typeof AgorLocalAuthMode];

/** Supported external projection providers. */
export const AgorExternalIdentityProvider = {
  EXTERNAL_LAUNCH: 'external_launch',
} as const;
export type AgorExternalIdentityProvider =
  (typeof AgorExternalIdentityProvider)[keyof typeof AgorExternalIdentityProvider];

/** Supported external projection provisioning strategies. */
export const AgorExternalIdentityProvisioning = {
  JIT: 'jit',
} as const;
export type AgorExternalIdentityProvisioning =
  (typeof AgorExternalIdentityProvisioning)[keyof typeof AgorExternalIdentityProvisioning];

/** External identity provisioning settings. */
export interface AgorExternalIdentitySettings {
  /** Verified authentication handoff that provisions users. */
  provider?: AgorExternalIdentityProvider;
  /** Create/update a local projection when a verified external login succeeds. */
  provisioning?: AgorExternalIdentityProvisioning;
}

/**
 * Deployment-owned authority contract for user identity.
 *
 * The section is optional. Omitting it preserves Agor's normal local user,
 * role, and password authority. The only external profile supported in v1 is
 * deliberately coherent: external lifecycle, claim-owned roles, disabled
 * local login, and verified launch-time JIT provisioning.
 */
export interface AgorIdentitySettings {
  user_lifecycle?: AgorUserLifecycleAuthority;
  role_authority?: AgorRoleAuthority;
  local_auth?: AgorLocalAuthMode;
  /** Named policy for newly assigned local passwords. Defaults to `secure`. */
  password_policy?: AgorPasswordPolicyProfile;
  external?: AgorExternalIdentitySettings;
}

export const IDENTITY_AUTHORITY_CONTRACT_VERSION = 1 as const;

/** Stable identifiers returned in externally-managed mutation errors. */
export const AgorIdentityCapability = {
  USER_CREATE: 'users.create',
  USER_DELETE: 'users.delete',
  USER_IDENTITY_WRITE: 'users.identity.write',
  USER_ROLE_WRITE: 'users.role.write',
  USER_PASSWORD_WRITE: 'users.password.write',
  USER_AVATAR_SETTINGS_WRITE: 'users.avatar-settings.write',
  USER_SELF_CONFIGURATION_WRITE: 'users.self-configuration.write',
} as const;
export type AgorIdentityCapability =
  (typeof AgorIdentityCapability)[keyof typeof AgorIdentityCapability];

/** Resolved identity policy and client capability contract exposed by the daemon. */
export interface ResolvedIdentityAuthority {
  contractVersion: typeof IDENTITY_AUTHORITY_CONTRACT_VERSION;
  userLifecycle: AgorUserLifecycleAuthority;
  roleAuthority: AgorRoleAuthority;
  localAuth: AgorLocalAuthMode;
  external?: {
    provider: AgorExternalIdentityProvider;
    provisioning: AgorExternalIdentityProvisioning;
  };
  capabilities: {
    users: {
      create: boolean;
      delete: boolean;
      identityWrite: boolean;
      roleWrite: boolean;
      passwordWrite: boolean;
      avatarSettingsWrite: boolean;
      selfConfigurationWrite: true;
    };
  };
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
 * Execution substrate and local filesystem-isolation mode.
 *
 * - `simple` — all processes run as the daemon user (no OS isolation)
 * - `delegated` — external launcher/substrate execution; every user MUST have
 *   a `unix_username` home key, which is passed to the execution
 *   substrate (e.g. the `{unix_user}` executor-command-template variable, which
 *   hosted deployments use to select per-user home mounts) and its absence
 *   fails loudly instead of silently sharing an identity
 * - `sandbox` — daemon-user execution with isolation enforced by the executor
 *   **filesystem sandbox** (bubblewrap): RBAC is on,
 *   each session gets a per-owner home overlay (`sandbox.home_mode: per_user`),
 *   and the branch is mounted per the caller's effective permission tier.
 *   Linux only. See
 *   `context/explorations/executor-sandboxing.md`.
 */
export type UnixUserMode = 'simple' | 'delegated' | 'sandbox';

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
 * Which Agor-managed dynamic roots the sandbox should grant WRITE access to.
 * The daemon/executor resolves each `true` flag to the concrete absolute path
 * it already knows (branch working dir, base repo, /tmp, $HOME) and merges it
 * into the effective `filesystem.allowWrite` list. Reads stay open by default
 * (SRT model); see `protect_secrets` / `isolate_branches` for read denials.
 */
export interface AgorSandboxIncludeSettings {
  /** Branch working directory. Effectively always true. Default: true. */
  branch?: boolean;
  /**
   * The shared base repository (`~/.agor/repos/<slug>`), REQUIRED for git in
   * worktree storage mode (the branch's `.git` is a pointer into it). Default: true.
   */
  base_repo?: boolean;
  /** `/tmp` (+ a task-private temp). Default: true. */
  tmp?: boolean;
  /** All of `$HOME` (dangerous — secrets still denied via `protect_secrets`). Default: false. */
  home?: boolean;
}

/**
 * OS-level executor sandbox policy. Global, single-policy — deliberately NOT
 * per-session to avoid config-hell. Disabled by default; `agor init` offers a
 * one-shot opt-in.
 *
 * When enabled, Agor wraps each AGENT executor spawn (prompt tasks + web
 * terminals) in `bubblewrap` at the `spawnExecutorLocal` chokepoint, so the
 * isolation policy is uniform across tools — not per-tool. (Daemon-internal
 * bounded executor commands run unwrapped as Agor's own code.) The sandbox
 * unshares the user + mount namespaces (and PID where the host allows it) but
 * NOT the network (`--share-net`), so the executor keeps its daemon/model
 * connectivity. Network egress control, if wanted, is left to each tool's own config.
 *
 * Agor resolves `include.*` / `protect_secrets` / `isolate_branches` into
 * bubblewrap bind mounts + masks using paths it already knows. See
 * `context/explorations/executor-sandboxing.md`.
 */
export interface AgorSandboxSettings {
  /** Master switch. Default: false (open filesystem; tool approval flows still apply). */
  enabled?: boolean;
  /** Dynamic write roots Agor grants (branch/base_repo/tmp/home). */
  include?: AgorSandboxIncludeSettings;
  /**
   * Deny reads of the daemon trust-root + common credential dirs
   * (`~/.agor/config.yaml`, `agor.db`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
   * `~/.config/gcloud`, `~/.npmrc`). Applied even when `include.home` is true.
   * Default: true.
   */
  protect_secrets?: boolean;
  /**
   * Cross-branch read isolation: mask the worktrees root, then re-expose only
   * the current branch. Gives isolation even in `simple`/`delegated` mode
   * (where all branches share the daemon uid). Default: true.
   */
  isolate_branches?: boolean;
  /**
   * How the executor's `$HOME` is presented inside the sandbox:
   *  - `shared` (default): the daemon user's real home, with tool state/cache
   *    dirs writable and the daemon trust-root + credential dirs masked.
   *  - `per_user`: overlay a **per-execution-user home store**
   *    (`<data_home>/tenants/<tenant>/homes/<user_id>`) at the passwd home, so
   *    `~` is a private, persistent home. Historical execution-home sessions
   *    select their owner; branch-home sessions select the current prompt
   *    actor. The overlay hides the entire daemon `.agor` tree (config, db,
   *    worktrees, repos) and every other user's home by construction. When the
   *    data root lives outside the passwd home, Agor masks that root explicitly.
   *    Symlink aliases of the home and data root are masked as well. The branch,
   *    base repo, and managed agentic-tools are re-exposed on top. This is the
   *    substrate that lets per-user isolation work without host accounts.
   *    Default: `shared`.
   */
  home_mode?: 'shared' | 'per_user';
  /**
   * Whether fresh sessions on an unadopted branch receive a per-branch SDK
   * home (relocating the agentic tool's config/state dir —
   * `.claude`/`.codex`/… — to a branch-keyed directory under
   * `<tenantDataRoot>/branch-homes/<branchId>`) instead of inheriting the
   * session-owner's home:
   *  - `inherit` (default): an unadopted branch creates execution-home sessions.
   *    Existing sessions and previously adopted branches retain their durable
   *    behavior. Byte-for-byte identical to a deployment that never set this key.
   *  - `per_branch`: the first supported independent session on an unadopted
   *    branch records branch intent and is stamped to use the branch SDK home.
   *    The branch record governs future independent sessions; the immutable
   *    Session stamp governs resume. Flipping back to `inherit` stops adoption
   *    of other branches without moving any existing SDK conversation.
   * Default: `inherit`.
   */
  sdk_home_mode?: 'inherit' | 'per_branch';
  /**
   * Preserve a symlinked daemon home's canonical alias inside a per-user
   * sandbox. The owner store and authorized dynamic paths are exposed at both
   * the passwd-home path and its daemon-resolved canonical path, and the
   * canonical branch path becomes the executor cwd. This keeps path-keyed SDK
   * state resumable on non-standard hosts without exposing the canonical homes
   * parent. Default: false.
   */
  preserve_canonical_home_alias?: boolean;
  /** Extra writable paths added to the `include.*` roots (escape hatch). */
  extra_allow_write?: string[];
  /** Extra denied-read paths added to `protect_secrets` (escape hatch). */
  extra_deny_read?: string[];
  /**
   * Hard-fail a task if the sandbox cannot start (missing bubblewrap 0.12.0+,
   * unavailable `--bind-fd`, blocked user namespaces, or unsupported platform)
   * instead of running unsandboxed. Recommended `true` for production security
   * gates. Default: false.
   */
  fail_if_unavailable?: boolean;
}

/**
 * Execution settings
 */
export interface AgorExecutionSettings {
  /**
   * Lightweight heartbeat settings for long-running executor tasks.
   *
   * The executor reports `tasks.last_executor_heartbeat_at` immediately and
   * then every `interval_ms` while a task is active. After `stale_after_ms`,
   * the daemon requests containment and fails the task only after verified absence.
   * Optional callbacks are shell commands that receive a small JSON payload on
   * stdin; keep secrets out of the command argv.
   */
  executor_heartbeat?: AgorExecutorHeartbeatSettings;
  sdk_watchdog?: {
    mode?: 'disabled' | 'observe' | 'enforce';
    first_progress_timeout_ms?: number;
    abort_grace_ms?: number;
    claude_idle_timeout_ms?: number | null;
  };

  dispatch_connect_timeout_ms?: number | null;

  /** Bounded executor-to-daemon response channel for synchronous commands. */
  executor_response?: AgorExecutorResponseSettings;

  /** Execution mode: trusted local, delegated external, or local Linux sandbox. */
  unix_user_mode?: UnixUserMode;

  /** Enable branch RBAC and ownership enforcement (default: false). */
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
   * secret. Use `unix_user_mode: sandbox` for local multi-user isolation. The
   * daemon emits a startup warning when this flag is enabled in `simple` mode.
   *
   * Branch-level permissions still apply: opening a terminal against a
   * branch requires at least `session` permission on that branch.
   *
   * Terminals are branch-scoped, owner-local, ephemeral attachments. In HA,
   * only the `shared-local` execution topology may enable this flag; external
   * runtimes remain disabled until they provide owner-affine routing.
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
   * Executor command template for remote/containerized execution.
   *
   * When null/undefined (default), executors are spawned as local subprocesses.
   * When set, the template is used to spawn executors in containers/pods.
   *
   * Template variables (substituted at spawn time):
   * - {task_id} - Unique task identifier (for pod naming)
   * - {command} - Executor command (prompt, git.clone, etc.)
   * - {unix_user} - Compatibility delegated home key
   * - {session_id} - Session ID (if available)
   * - {branch_id} - Branch ID (if available)
   * - {user_id} - Trusted authenticated Agor user UUID (if available)
   * - {branch_fs_access} - Actor's branch projection: none, read, or write
   * - {branch_sdk_home} - Absolute path for a branch-home Session, or empty for
   *   an execution-home Session
   * - {tenant_id} - Trusted ambient tenant ID (shell-escaped; fails if unavailable)
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
   *     --labels="agor-tenant={tenant_id},agor-user={user_id}" \
   *     -- agor-executor --stdin
   * ```
   *
   * @example Docker execution
   * ```yaml
   * executor_command_template: |
   *   docker run --rm -i \
   *     --label agor.tenant={tenant_id} --label agor.user={user_id} \
   *     -v /data/agor:/data/agor \
   *     ghcr.io/preset-io/agor-executor:latest \
   *     agor-executor --stdin
   * ```
   */
  executor_command_template?: string;

  /**
   * Filesystem guarantees provided to every executor invocation.
   *
   * This is an operator assertion about the execution substrate, not a mount
   * instruction interpreted by the daemon. It applies to templated executors
   * even when the daemon itself is standalone; HA consumes it to fail unsafe
   * topology combinations at startup.
   */
  executor_storage?: AgorExecutorStorageSettings;

  /** A nonzero template launcher may still have submitted remote work. Default: false. */
  executor_command_nonzero_may_have_dispatched?: boolean;

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

  /**
   * OS-level executor sandbox policy (SRT: bubblewrap / Seatbelt). Disabled by
   * default. Global, single-policy. See `context/explorations/executor-sandboxing.md`.
   */
  sandbox?: AgorSandboxSettings;
}

export interface AgorExecutorResponseSettings {
  /** Maximum uncompressed framed response-body bytes. Default: 8 MiB. */
  max_response_bytes?: number;
  /** Maximum in-flight response reservations on one daemon. Default: 16. */
  max_active_requests?: number;
  /** Request-mode timeout defaults and optional exact-command overrides. */
  timeout_ms?: {
    /** Default timeout for request-mode commands. Default: 5 minutes. */
    default?: number;
    /** Overrides keyed by the executor payload's exact `command` value. */
    by_command?: Record<string, number>;
  };
  /**
   * Exact initiating-daemon origin reachable by executors. In standalone
   * local mode startup derives this from the daemon listener. HA/external
   * deployments must configure an origin that does not load-balance to
   * another replica.
   */
  origin_url?: string;
  /** Operator assertion required for request-mode templated execution. */
  external_protocol?: 'executor-response-v1';
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
  allowShallowClones: boolean;
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

  /**
   * Whether callers may request a positive `clone_depth`. Defaults to true
   * for backwards compatibility. Set false when every clone-mode branch must
   * carry complete history.
   */
  allow_shallow_clones?: boolean;

  /**
   * Whether clone-mode branches may borrow objects from the daemon-managed
   * base clone via `git clone --reference` (an `alternates` pointer into
   * `<data_home>/repos/<slug>/.git/objects`). On a single-mount install this
   * is a large disk win and nothing else changes.
   *
   * The alternates pointer is baked into the branch at create time and
   * consumed by every later `git` command, so a branch created with a borrow
   * it cannot resolve is permanently broken:
   *
   * ```
   * error: unable to normalize alternate object path: /…/.agor/repos/<org>/<repo>/.git/objects
   * fatal: Failed to traverse parents of commit <sha>
   * ```
   *
   * Tri-state — leave unset unless you have a reason:
   *  - unset (default): borrow, unless Agor can see that sessions will not be
   *    able to resolve the pointer. Today that inference fires for
   *    `execution.sandbox.enabled` + `home_mode: per_user`, whose owner-home
   *    overlay hides the whole daemon `.agor` tree including `repos/`.
   *  - `false`: never borrow. Use this for containerized / templated executors
   *    that bind only the branch workspace — Agor cannot inspect an external
   *    substrate's mounts, so it has to be told.
   *  - `true`: always borrow, even where Agor would have inferred otherwise.
   *    You are asserting the base clone is reachable from sessions (for
   *    example via `execution.sandbox.extra_allow_write`).
   *
   * `execution.executor_storage.base_repository: 'unavailable'` outranks all
   * three: it asserts the base checkout does not exist for executors at all.
   *
   * Disabling costs disk (each branch carries a full object store) and buys
   * mount-independence.
   */
  borrow_base_objects?: boolean;
}

/** Consistency of the effective user's home across executor invocations. */
export type AgorExecutorUserHomeStorage = 'replica-local' | 'shared' | 'persistent-per-user';

/** Consistency and isolation of branch working copies across executors. */
export type AgorExecutorBranchWorkspaceStorage =
  | 'replica-local'
  | 'shared'
  | 'persistent-per-branch';

/** Availability of the registered repository's base checkout to executors. */
export type AgorExecutorBaseRepositoryStorage = 'replica-local' | 'shared' | 'unavailable';

/** Scope in which advisory locks on the user-home filesystem are coherent. */
export type AgorExecutorUserHomeLocking = 'local-only' | 'cross-replica-flock';

/**
 * Declarative execution-substrate storage contract.
 *
 * `persistent-per-user` is keyed by trusted tenant/user identity and is the
 * only mode suitable for user credential homes in a multi-tenant external
 * executor fleet. `persistent-per-branch` similarly means any invocation for
 * a branch sees the same durable working copy at the DB-recorded path.
 */
export interface AgorExecutorStorageSettings {
  user_home?: AgorExecutorUserHomeStorage;
  /**
   * Operator assertion about the backing filesystem, not a mount option Agor
   * configures. HA Codex credential mutation requires `cross-replica-flock`.
   */
  user_home_locking?: AgorExecutorUserHomeLocking;
  branch_workspace?: AgorExecutorBranchWorkspaceStorage;
  base_repository?: AgorExecutorBaseRepositoryStorage;
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
 * Public community telemetry settings.
 *
 * This is intentionally separate from `analytics`: `analytics` is for
 * operator-configured instance analytics, while `telemetry` is Agor's
 * lightweight opt-in community install and aggregate usage telemetry.
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
 * DogStatsD transport settings for daemon operational metrics.
 *
 * Metrics are process-global operational signals, not tenant analytics. Keep
 * global tags deployment-level and low-cardinality; request/resource IDs are
 * deliberately forbidden by config validation.
 */
export interface AgorStatsDSettings {
  /** Master switch. Defaults to false. */
  enabled?: boolean;

  /** Datadog Agent / StatsD UDP host. Defaults to 127.0.0.1. */
  host?: string;

  /** Datadog Agent / StatsD UDP port. Defaults to 8125. */
  port?: number;

  /** Namespace prepended to every daemon metric. Must end in a dot. */
  prefix?: string;

  /** Static, deployment-level DogStatsD tags applied to every metric. */
  global_tags?: Record<string, string>;
}

/** Valid depths for FeathersJS service-method tracing, cheapest first. */
export const APM_TRACE_SERVICE_DEPTHS = ['off', 'entrypoint', 'full'] as const;
export type ApmTraceServiceDepth = (typeof APM_TRACE_SERVICE_DEPTHS)[number];

/**
 * Datadog APM (dd-trace) tracing knobs for the daemon.
 *
 * The tracer itself is loaded process-wide (single-step / `NODE_OPTIONS`
 * injection), which already auto-instruments HTTP, Express, Postgres, and
 * Redis. These settings govern Agor's custom tracing layers: the FeathersJS
 * service-method layer and the postgres.js Drizzle query shim, both of which
 * dd-trace has no native plugin for. `off` disables both custom layers.
 */
export interface AgorApmSettings {
  /**
   * Depth of custom Agor tracing. Defaults to `off`.
   *
   * PostgreSQL query tracing is enabled for either `entrypoint` or `full` and
   * disabled for `off`. The depth only affects FeathersJS service spans.
   *
   * - `off`: neither custom tracing layer is registered — zero custom tracing
   *   overhead (including no database shim patch and no tracer resolution).
   * - `entrypoint`: one span per top-level request; nested service-to-service
   *   fan-out is suppressed (mirrors the StatsD metrics hook). Cheap and
   *   bounded — safe to leave on in production.
   * - `full`: a span per service-method invocation including nested calls, so
   *   the fan-out and its child Postgres queries are visible in the flame
   *   graph. Highest span volume (and ingestion cost) — intended for active
   *   investigation, not steady state.
   */
  trace_services?: ApmTraceServiceDepth;
}

/** Optional daemon operational metrics exporters. */
export interface AgorMetricsSettings {
  statsd?: AgorStatsDSettings;

  /** Datadog APM (dd-trace) tracing knobs. */
  apm?: AgorApmSettings;
}

/**
 * Backend analytics settings.
 *
 * Disabled by default. When enabled, daemon/server code sends curated
 * lifecycle events through a central analytics client. Plugin configuration is
 * resolved by type at daemon startup. Events emitted inside a trusted tenant
 * scope automatically include that tenant as `context.tenant_id`.
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
  | AgorAnalyticsHttpBatchPluginSettings;

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

/** Operator-owned defaults for creating AI teammates. */
export interface AgorTeammateSettings {
  /** Repository cloned by the onboarding wizard when creating the first teammate. */
  framework_repo_url?: string;
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
  /** Store tenant-owned filesystem data below a tenant-specific root. Defaults to false. */
  filesystem_isolation_enabled?: boolean;

  /**
   * Parent directory for tenant data. Absolute paths and paths relative to
   * `~/.agor` are supported. Defaults to `~/.agor/tenants`.
   */
  tenants_base_folder?: string;

  /** Multi-tenancy mode. Defaults to `static`. */
  mode?: 'static' | 'required_from_auth';

  /** Static tenant id for self-hosted/single-instance mode. Defaults to `default`. */
  static_tenant_id?: string;

  /** JWT/user claim name to read in `required_from_auth` mode, e.g. `tenant_id`. */
  auth_claim?: string;

  /** Optional trusted HTTP header set by an auth/edge layer, e.g. `x-agor-tenant-id`. */
  trusted_header?: string;
}

/** Canonical upload storage and lifecycle settings. */
export interface AgorUploadSettings {
  /**
   * Base local directory or S3 URI. Defaults to `~/.agor`.
   * Agor manages the tenant and feature namespaces below this base.
   * Credentials are resolved out-of-band and must not be embedded in this URI.
   */
  location?: string;

  /** Maximum age from creation in days. Zero disables automatic expiry. */
  max_age_days?: number;

  /** Maximum bytes accepted for one file, expressed in MiB. */
  max_file_size_mb?: number;
}

/** Explicit daemon deployment topology. HA is never inferred from Redis. */
export type AgorDeploymentMode = 'standalone' | 'ha';

/**
 * Deliberately constrained first active-active support envelope. This is an
 * operator acknowledgement, not a claim that every Agor surface is movable.
 */
export type AgorHaSupportProfile = 'constrained-active-active';

/** How tenant workspace operations reach their filesystem authority in HA. */
export type AgorHaExecutionTopology = 'shared-local' | 'external';

/** Redis fanout settings used only when {@link AgorDeploymentSettings.mode} is `ha`. */
export interface AgorRedisSettings {
  /** redis:// or rediss:// URL. Prefer an environment override for credentials. */
  url?: string;
  /** Deployment-unique operational namespace (not an authorization boundary). */
  key_prefix?: string;
  /** TCP/TLS connect timeout. Default: 5000. */
  connect_timeout_ms?: number;
  /** Total startup window for both pub/sub clients. Default: 15000. */
  startup_timeout_ms?: number;
  /** Socket.IO adapter inter-server request timeout. Default: 5000. */
  request_timeout_ms?: number;
  /** Initial reconnect delay. Default: 100. */
  reconnect_base_delay_ms?: number;
  /** Maximum reconnect delay. Default: 2000. */
  reconnect_max_delay_ms?: number;
}

/** Operator assertions required for the first supported HA topology. */
export interface AgorHaTopologySettings {
  /** Required explicit acknowledgement of the constrained initial HA surface. */
  support_profile?: AgorHaSupportProfile;
  /**
   * `shared-local` runs executor commands beside each daemon and therefore
   * requires identical workspace paths. `external` routes them through an
   * explicitly configured executor command template and requires no tenant
   * filesystem mount in daemon pods.
   */
  execution_topology?: AgorHaExecutionTopology;
  /** Required only for `shared-local`; not a general HA/Cloud requirement. */
  shared_filesystem?: boolean;
  /** The ingress keeps Engine.IO polling requests on one daemon. */
  ingress_affinity?: boolean;

  /** PostgreSQL-coordinated managed-environment health observation worker. */
  environment_health_monitor?: AgorHaEnvironmentHealthMonitorSettings;
}

export interface AgorHaEnvironmentHealthMonitorSettings {
  /** Delay between active scans before idle backoff. Default: 5000. */
  scan_interval_ms?: number;
  /** Maximum idle discovery backoff. Default: 30000. */
  max_idle_interval_ms?: number;
  /** Per-replica randomized startup offset ceiling. Default: 3000. */
  startup_offset_max_ms?: number;
  /** Maximum routing references returned by one discovery page. Default: 32. */
  scan_batch_size?: number;
  /** Maximum concurrent HTTP observations on one daemon. Default: 8. */
  max_in_flight?: number;
  /** Per-request health endpoint timeout. Default: 1000. */
  http_timeout_ms?: number;
  /** One-observation database lease. Must exceed HTTP timeout by 5000ms. Default: 15000. */
  claim_lease_ms?: number;
  /** Graceful shutdown drain bound. Default: 5000. */
  shutdown_drain_timeout_ms?: number;
}

export interface AgorDeploymentSettings {
  /** Defaults to standalone. REDIS_URL alone never changes this value. */
  mode?: AgorDeploymentMode;
  redis?: AgorRedisSettings;
  ha?: AgorHaTopologySettings;
}

/**
 * Complete Agor configuration
 */
export interface AgorConfig {
  /** Deployment-owned agentic-tool package selection. */
  agentic_tools?: AgorAgenticToolsSettings;

  /** Explicit standalone or multi-daemon topology. */
  deployment?: AgorDeploymentSettings;

  /** Daemon settings */
  daemon?: AgorDaemonSettings;

  /** UI settings */
  ui?: AgorUISettings;

  /** Database configuration */
  database?: AgorDatabaseSettings;

  /** Generic external one-time launch-code authentication. */
  external_launch?: AgorExternalLaunchSettings;

  /** User identity, lifecycle, role, and local-login authority. */
  identity?: AgorIdentitySettings;

  /** Execution isolation settings */
  execution?: AgorExecutionSettings;

  /** Security headers & CORS (CSP extras/override, CORS mode/origins, etc.) */
  security?: AgorSecuritySettings;

  /** Operator-owned teammate bootstrap settings. */
  teammates?: AgorTeammateSettings;

  /** Path configuration (data_home for repos/branches separation) */
  paths?: AgorPathSettings;

  /** Backend analytics settings. Disabled by default. */
  analytics?: AgorAnalyticsSettings;

  /** Public community telemetry settings. */
  telemetry?: AgorTelemetrySettings;

  /** Operational daemon metrics. Disabled by default. */
  metrics?: AgorMetricsSettings;

  /** App-level multi-tenancy settings. Defaults to static/default tenant. */
  multi_tenancy?: AgorMultiTenancySettings;

  /** Upload storage and lifecycle policy. */
  uploads?: AgorUploadSettings;
}

/**
 * Valid config keys (includes nested keys with dot notation)
 */
export type ConfigKey =
  | `agentic_tools.${keyof AgorAgenticToolsSettings}`
  | `deployment.${keyof AgorDeploymentSettings}`
  | `daemon.${keyof AgorDaemonSettings}`
  | `ui.${keyof AgorUISettings}`
  | `database.${keyof AgorDatabaseSettings}`
  | `external_launch.${keyof AgorExternalLaunchSettings}`
  | `identity.${keyof AgorIdentitySettings}`
  | `execution.${keyof AgorExecutionSettings}`
  | `security.${keyof AgorSecuritySettings}`
  | `teammates.${keyof AgorTeammateSettings}`
  | `paths.${keyof AgorPathSettings}`
  | `analytics.${keyof AgorAnalyticsSettings}`
  | `telemetry.${keyof AgorTelemetrySettings}`
  | `metrics.${keyof AgorMetricsSettings}`
  | `multi_tenancy.${keyof AgorMultiTenancySettings}`
  | `uploads.${keyof AgorUploadSettings}`;
