/**
 * ExecutorPayload - The private API contract between daemon and executor
 *
 * This is NOT a public CLI interface. It's an RPC protocol that happens
 * to use subprocess + stdin as the transport.
 *
 * All commands connect to daemon via Feathers and do complete transactions
 * (filesystem + DB + events). Unix operations are internal to git commands.
 */

import { type ResolvedConfigSlice, ResolvedConfigSliceSchema } from '@agor/core/config';
import { z } from 'zod';

// Re-export so existing executor consumers (handlers, tool-registry, etc.)
// keep importing from `../payload-types.js` without churn. The schema and
// type are owned by @agor/core — see packages/core/src/config/resolved-config-slice.ts.
export { type ResolvedConfigSlice, ResolvedConfigSliceSchema };

// ═══════════════════════════════════════════════════════════
// URL Validation
// ═══════════════════════════════════════════════════════════

/**
 * Validate a git-compatible URL
 *
 * Git supports multiple URL formats:
 * - HTTPS: https://github.com/user/repo.git
 * - SSH (scp-style): git@github.com:user/repo.git
 * - SSH (protocol): ssh://git@github.com/user/repo.git
 * - Git protocol: git://github.com/user/repo.git
 * - Local path: /path/to/repo or ./relative/path
 * - File URL: file:///path/to/repo
 */
function isGitUrl(value: string): boolean {
  // HTTPS/HTTP URLs
  if (/^https?:\/\/.+/.test(value)) return true;

  // Git protocol URLs
  if (/^git:\/\/.+/.test(value)) return true;

  // SSH protocol URLs (ssh://git@github.com/user/repo.git)
  if (/^ssh:\/\/.+/.test(value)) return true;

  // SSH scp-style URLs (git@github.com:user/repo.git)
  if (/^[\w.-]+@[\w.-]+:.+/.test(value)) return true;

  // File URLs
  if (/^file:\/\/.+/.test(value)) return true;

  // Local absolute paths (Unix-style)
  if (/^\//.test(value)) return true;

  // Local relative paths
  if (/^\.\.?\//.test(value)) return true;

  return false;
}

/**
 * Git URL schema - accepts HTTPS, SSH, git://, file://, and local paths
 */
const GitUrlSchema = z.string().refine(isGitUrl, {
  message:
    'Invalid git URL. Supported formats: https://, ssh://, git://, git@host:path, file://, or local path',
});

// ═══════════════════════════════════════════════════════════
// Shared Schemas
// ═══════════════════════════════════════════════════════════

/**
 * Tool types supported by the prompt command
 */
export const ToolTypeSchema = z.enum([
  'claude-code',
  'claude-code-cli',
  'gemini',
  'codex',
  'opencode',
  'copilot',
  'cursor',
]);
export type ToolType = z.infer<typeof ToolTypeSchema>;

/**
 * Permission modes for agent execution
 *
 * Union of all native SDK permission modes - no mapping needed.
 * Each agent uses its own subset directly.
 *
 * Claude Code: default, acceptEdits, bypassPermissions, plan, dontAsk
 * Gemini: default, autoEdit, yolo
 * Codex: ask, auto, on-failure, allow-all
 */
export const PermissionModeSchema = z.enum([
  // Claude Code native modes
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  // Gemini native modes
  'autoEdit',
  'yolo',
  // Codex native modes
  'ask',
  'auto',
  'on-failure',
  'allow-all',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

// ═══════════════════════════════════════════════════════════
// Base Payload Schema
// ═══════════════════════════════════════════════════════════

/**
 * Base payload - common fields for all commands
 *
 * NOTE: Impersonation (asUser) is NOT in the payload. It's handled at spawn time
 * by the daemon using buildSpawnArgs(). The executor runs directly as the target user.
 */
export const BasePayloadSchema = z.object({
  /** Executor command identifier */
  command: z.string(),

  /** Daemon URL for Feathers connection */
  daemonUrl: z.string().url().optional(),

  /** Environment variables to inject */
  env: z.record(z.string(), z.string()).optional(),

  /** Data home directory override */
  dataHome: z.string().optional(),

  /**
   * Daemon-resolved config slice. See {@link ResolvedConfigSliceSchema}.
   * Optional so the legacy CLI-args mode still validates; handlers must
   * apply defaults when missing.
   */
  resolvedConfig: ResolvedConfigSliceSchema.optional(),
});

// ═══════════════════════════════════════════════════════════
// Prompt Payload
// ═══════════════════════════════════════════════════════════

/**
 * Prompt execution payload - execute agent SDK
 */
export const PromptPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('prompt'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    sessionId: z.string().uuid(),
    taskId: z.string().uuid(),
    prompt: z.string(),
    tool: ToolTypeSchema,
    permissionMode: PermissionModeSchema.optional(),
    cwd: z.string(),
    messageSource: z.enum(['gateway', 'agor']).optional(),
  }),
});

export type PromptPayload = z.infer<typeof PromptPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Clone Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git clone payload - clone repository with full Unix setup
 *
 * When createDbRecord is true (default), the executor will:
 * 1. Clone the repository to outputPath
 * 2. Create a repo record in the database via Feathers
 * 3. Initialize Unix group (if initUnixGroup is true)
 */
export const GitClonePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.clone'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repository URL (https, ssh, git://, file://, or local path) */
    url: GitUrlSchema,

    /** Output path for the repository (optional, defaults to AGOR_DATA_HOME/repos/) */
    outputPath: z.string().optional(),

    /** Branch to checkout (optional) */
    branch: z.string().optional(),

    /** Clone as bare repository */
    bare: z.boolean().optional(),

    /** Slug for the repo (computed from URL if not provided) */
    slug: z.string().optional(),

    /**
     * User-supplied default branch for the repo record. When provided, this
     * overrides the auto-detected `origin/HEAD`. Used by the UI's "Add
     * Repository" form so the operator can pin a non-default base branch
     * for new branches (e.g. a long-lived feature branch).
     */
    default_branch: z.string().optional(),

    /** Create DB record after clone (default: true) */
    createDbRecord: z.boolean().optional().default(true),

    /**
     * Pre-existing repo row to patch with clone outcome. When set, the
     * executor patches this row with `clone_status: 'ready'` (success) or
     * `'failed'` (with `clone_error`) instead of creating a new row. The
     * daemon pre-creates the row in `cloneRepository` so failures are
     * persisted (and queryable) instead of vanishing into a dropped
     * `{ status: 'pending' }` response.
     */
    repoId: z.string().optional(),

    /** User ID of the requesting user (for per-user credential resolution) */
    userId: z.string().uuid().optional(),

    /** Initialize Unix group for repo isolation (default: false, requires RBAC enabled) */
    initUnixGroup: z.boolean().optional().default(false),
  }),
});

export type GitClonePayload = z.infer<typeof GitClonePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Branch Add Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git branch add payload - create branch filesystem
 *
 * The daemon creates the DB record BEFORE calling this (with filesystem_status: 'creating').
 * The executor:
 * 1. Creates the git branch at branchPath
 * 2. Sets up Unix group/ACLs (if initUnixGroup is true)
 * 3. Patches the branch record to filesystem_status: 'ready' (or 'failed')
 */
/**
 * Cross-field invariants for the `git.branch.add` params:
 *  - clone-mode requires a `remoteUrl` (the executor has no other way to
 *    learn where to clone from, since `repoPath` points at the daemon-owned
 *    base clone that clone-mode intentionally bypasses).
 *  - shallow-clone depth only applies to clone-mode (worktree mode has no
 *    `--depth` knob); reject `cloneDepth` paired with worktree mode rather
 *    than silently dropping it.
 *
 * These are also belt-and-suspenders-checked in the daemon service and the
 * executor handler, but having them at the schema boundary means malformed
 * payloads fail at parse time with a clear message.
 */
const enforceClonePayloadInvariants = (
  params: { storageMode?: 'worktree' | 'clone'; remoteUrl?: string; cloneDepth?: number },
  ctx: z.RefinementCtx
): void => {
  if (params.storageMode === 'clone' && !params.remoteUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remoteUrl'],
      message: "remoteUrl is required when storageMode === 'clone'",
    });
  }
  if (params.cloneDepth !== undefined && params.storageMode !== 'clone') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cloneDepth'],
      message:
        "cloneDepth is only meaningful when storageMode === 'clone'; omit it for worktree mode",
    });
  }
};

export const GitBranchAddPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.branch.add'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z
    .object({
      /** Branch ID (UUID) - DB record already exists with filesystem_status: 'creating' */
      branchId: z.string().uuid(),

      /** Repo ID (UUID) */
      repoId: z.string().uuid(),

      /** Path to the repository */
      repoPath: z.string(),

      /** Name for the branch */
      branchName: z.string(),

      /** Path where branch will be created */
      branchPath: z.string(),

      /** Branch to checkout or create */
      branch: z.string().optional(),

      /** Source branch when creating new branch */
      sourceBranch: z.string().optional(),

      /** Create new branch */
      createBranch: z.boolean().optional(),

      /** Use restore mode: smart branch detection via ls-remote, falls back to creating from sourceBranch */
      restoreMode: z.boolean().optional(),

      /** Type of ref (branch or tag) */
      refType: z.enum(['branch', 'tag']).optional(),

      /** Initialize Unix group for branch isolation (default: false, requires RBAC enabled) */
      initUnixGroup: z.boolean().optional().default(false),

      /** Access level for non-owners ('none' | 'read' | 'write') */
      othersAccess: z.enum(['none', 'read', 'write']).optional().default('read'),

      /** User ID of the requesting user (for per-user credential resolution) */
      userId: z.string().uuid().optional(),

      /**
       * Branch storage model. Default 'worktree' (native `git worktree add`,
       * legacy behaviour). 'clone' routes through `createBranchAsClone` for a
       * self-standing `git clone` — closes cross-branch leak vectors at the
       * `.git/config` layer. Forwarded from the branches DB record.
       */
      storageMode: z.enum(['worktree', 'clone']).optional(),

      /**
       * Shallow-clone depth. Only meaningful when storageMode='clone'. Positive
       * integer → `git clone --depth N`. Omit (or pass null/undefined) for a
       * full clone with complete history.
       */
      cloneDepth: z.number().int().positive().optional(),

      /**
       * Remote URL for clone-mode. Daemon resolves from the repo record and
       * forwards it; the executor uses it as the `git clone` source. Ignored
       * when storageMode='worktree'.
       */
      remoteUrl: z.string().optional(),

      /**
       * Optional `git clone --reference <path>` hint. Daemon resolves this
       * to the per-repo base clone (e.g. `~/.agor/repos/<slug>/`) and
       * forwards it; the executor checks the path on its own filesystem
       * before adding `--reference` to the clone command. Path missing
       * (different mount, base not seeded yet) → silent fallback to a
       * full clone. Ignored when storageMode='worktree'.
       */
      referencePath: z.string().optional(),
    })
    .superRefine(enforceClonePayloadInvariants),
});

export type GitBranchAddPayload = z.infer<typeof GitBranchAddPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Branch Remove Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git branch remove payload - remove branch and cleanup Unix resources
 *
 * When deleteDbRecord is true (default), the executor will:
 * 1. Remove the git branch from filesystem
 * 2. Delete the branch record from database via Feathers
 * 3. Clean up Unix group/ACLs (if RBAC enabled)
 */
export const GitBranchRemovePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.branch.remove'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Branch ID (UUID) - required for DB record deletion */
    branchId: z.string().uuid(),

    /** Path to the branch to remove */
    branchPath: z.string(),

    /** Force removal even if dirty */
    force: z.boolean().optional(),

    /** Delete DB record after removal (default: true) */
    deleteDbRecord: z.boolean().optional().default(true),

    /** Branch name to delete after branch removal */
    branch: z.string().optional(),

    /** Whether to delete the branch after branch removal (default: false) */
    deleteBranch: z.boolean().optional().default(false),

    /**
     * Storage mode of the branch being removed. Forwarded from the DB
     * record by the daemon. When 'clone', the executor skips the
     * `git worktree remove --force` call (clones aren't registered with the
     * base repo) and just removes the directory. Defaults to 'worktree' for
     * back-compat with payloads issued before this field existed.
     */
    storageMode: z.enum(['worktree', 'clone']).optional(),
  }),
});

export type GitBranchRemovePayload = z.infer<typeof GitBranchRemovePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Branch Clean Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git branch clean payload - remove untracked files and build artifacts
 *
 * Runs `git clean -fdx` which removes:
 * - Untracked files and directories
 * - Ignored files (node_modules, build artifacts, etc.)
 *
 * Preserves:
 * - .git directory
 * - Tracked files
 * - Git state (commits, branches)
 */
export const GitBranchCleanPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.branch.clean'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Path to the branch to clean */
    branchPath: z.string(),
  }),
});

export type GitBranchCleanPayload = z.infer<typeof GitBranchCleanPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Unix Sync Payloads - High-Level Sync Operations
// ═══════════════════════════════════════════════════════════

/**
 * Unix sync-branch payload - Sync all Unix state for a branch
 *
 * This is a high-level "sync" operation that handles everything:
 * - Ensure branch Unix group exists
 * - Set correct permissions based on others_fs_access
 * - Add all current owners to the branch group
 * - Add owners to repo group (for .git/ access)
 * - Fix .git/worktrees/<name>/ permissions
 * - Create symlinks in user home directories
 *
 * Idempotent: Safe to call multiple times. Executor figures out the delta.
 * Fire-and-forget: Daemon calls this and returns immediately.
 */
export const UnixSyncBranchPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('unix.sync-branch'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Branch ID to sync */
    branchId: z.string().uuid(),

    /** Daemon Unix user (added to all groups for daemon access) */
    daemonUser: z.string().optional(),

    /** If true, delete the group instead of syncing (for branch removal) */
    delete: z.boolean().optional(),
  }),
});

export type UnixSyncBranchPayload = z.infer<typeof UnixSyncBranchPayloadSchema>;

/**
 * Unix sync-repo payload - Sync all Unix state for a repo
 *
 * This handles:
 * - Ensure repo Unix group exists
 * - Set correct permissions on .git/ directory
 * - Add all branch owners to repo group
 *
 * Idempotent: Safe to call multiple times.
 */
export const UnixSyncRepoPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('unix.sync-repo'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repo ID to sync */
    repoId: z.string().uuid(),

    /** Daemon Unix user (added to repo group for daemon access) */
    daemonUser: z.string().optional(),

    /** If true, delete the group instead of syncing (for repo removal) */
    delete: z.boolean().optional(),
  }),
});

export type UnixSyncRepoPayload = z.infer<typeof UnixSyncRepoPayloadSchema>;

/**
 * Unix sync-user payload - Sync all Unix state for a user
 *
 * This handles:
 * - Ensure Unix user exists with correct shell
 * - Add to agor_users group
 * - Sync password (if provided)
 * - Setup home directory (~/.config/zellij, etc.)
 * - Sync symlinks for all owned branches
 */
export const UnixSyncUserPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('unix.sync-user'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** User ID to sync */
    userId: z.string().uuid(),

    /** Password to sync (optional, passed securely via stdin) */
    password: z.string().optional(),

    /** If true, delete the Unix user (for user removal) */
    delete: z.boolean().optional(),

    /** Also delete home directory when deleting user */
    deleteHome: z.boolean().optional(),

    /** If true, configure git safe.directory for this user (needed when unix impersonation is enabled) */
    configureGitSafeDirectory: z.boolean().optional(),
  }),
});

export type UnixSyncUserPayload = z.infer<typeof UnixSyncUserPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Zellij Payloads
// ═══════════════════════════════════════════════════════════

/**
 * Zellij attach payload - attach to or create Zellij session
 *
 * This spawns a PTY, runs zellij attach, and streams I/O over Feathers channels.
 * One executor per user - handles all tabs for that user.
 */
export const ZellijAttachPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('zellij.attach'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** User ID (for channel: user/${userId}/terminal) */
    userId: z.string().uuid(),

    /** Zellij session name (e.g., "agor-max") */
    sessionName: z.string(),

    /** Initial working directory */
    cwd: z.string(),

    /** Initial tab name (branch name) */
    tabName: z.string().optional(),

    /** Terminal dimensions */
    cols: z.number().optional().default(80),
    rows: z.number().optional().default(24),

    /** Path to env file for shell to source (user env vars like API keys) */
    envFile: z.string().nullable().optional(),
  }),
});

export type ZellijAttachPayload = z.infer<typeof ZellijAttachPayloadSchema>;

/**
 * Zellij tab payload - create or focus a tab in existing Zellij session
 *
 * Sent to running executor to manage tabs without spawning new PTY.
 */
export const ZellijTabPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('zellij.tab'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Action: create new tab, focus existing, or close-by-name */
    action: z.enum(['create', 'focus', 'close']),

    /** Tab name (branch name) */
    tabName: z.string(),

    /** Working directory (for 'create' action) */
    cwd: z.string().optional(),

    /**
     * Optional binary to run inside the new tab.
     * Maps to `zellij action new-tab --command <bin>`.
     *
     * Use case: spawn the `claude` shell binary directly into a tab so
     * its REPL is the tab's foreground process. Without this the tab
     * opens a default shell.
     *
     * Only honored when `action === 'create'`.
     */
    command: z.string().optional(),

    /**
     * Argv passed to `command`. Each element produces a separate
     * `--args <one>` repetition on the `zellij action new-tab` invocation
     * (Zellij requires this rather than space-separated argv).
     *
     * Ignored when `command` is omitted.
     */
    commandArgs: z.array(z.string()).optional(),

    /**
     * Force-recreate semantics for `action: 'create'`. Closes EVERY tab
     * matching `tabName` before issuing `new-tab` — bypasses the
     * default "tab exists → focus instead" auto-converse.
     *
     * Used by:
     *   - `/sessions/:id/restart-cli` — always wants a fresh `claude`.
     *   - The ensure-create path when the daemon detected the in-tab
     *     `claude` is dead (pgrep returned no match).
     *
     * Ignored when `action !== 'create'`.
     */
    forceRecreate: z.boolean().optional(),
  }),
});

export type ZellijTabPayload = z.infer<typeof ZellijTabPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Union Payload Type
// ═══════════════════════════════════════════════════════════

/**
 * All supported executor payloads
 */
export const ExecutorPayloadSchema = z.discriminatedUnion('command', [
  PromptPayloadSchema,
  GitClonePayloadSchema,
  GitBranchAddPayloadSchema,
  GitBranchRemovePayloadSchema,
  GitBranchCleanPayloadSchema,
  UnixSyncBranchPayloadSchema,
  UnixSyncRepoPayloadSchema,
  UnixSyncUserPayloadSchema,
  ZellijAttachPayloadSchema,
  ZellijTabPayloadSchema,
]);

export type ExecutorPayload = z.infer<typeof ExecutorPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Executor Result
// ═══════════════════════════════════════════════════════════

/**
 * Executor result - returned via stdout or Feathers
 */
export const ExecutorResultSchema = z.object({
  success: z.boolean(),

  /** Command-specific result data */
  data: z.unknown().optional(),

  /** Error information if success=false */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});

export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

// ═══════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════

/**
 * Parse and validate an ExecutorPayload from JSON string
 */
export function parseExecutorPayload(json: string): ExecutorPayload {
  const parsed = JSON.parse(json);
  return ExecutorPayloadSchema.parse(parsed);
}

/**
 * Check if the payload command is supported
 */
export function getSupportedCommands(): string[] {
  return [
    'prompt',
    'git.clone',
    'git.branch.add',
    'git.branch.remove',
    'git.branch.clean',
    'unix.sync-branch',
    'unix.sync-repo',
    'unix.sync-user',
    'zellij.attach',
    'zellij.tab',
  ];
}

/**
 * Type guard for PromptPayload
 */
export function isPromptPayload(payload: ExecutorPayload): payload is PromptPayload {
  return payload.command === 'prompt';
}

/**
 * Type guard for GitClonePayload
 */
export function isGitClonePayload(payload: ExecutorPayload): payload is GitClonePayload {
  return payload.command === 'git.clone';
}

/**
 * Type guard for GitBranchAddPayload
 */
export function isGitBranchAddPayload(payload: ExecutorPayload): payload is GitBranchAddPayload {
  return payload.command === 'git.branch.add';
}

/**
 * Type guard for GitBranchRemovePayload
 */
export function isGitBranchRemovePayload(
  payload: ExecutorPayload
): payload is GitBranchRemovePayload {
  return payload.command === 'git.branch.remove';
}

/**
 * Type guard for GitBranchCleanPayload
 */
export function isGitBranchCleanPayload(
  payload: ExecutorPayload
): payload is GitBranchCleanPayload {
  return payload.command === 'git.branch.clean';
}

/**
 * Type guard for UnixSyncBranchPayload
 */
export function isUnixSyncBranchPayload(
  payload: ExecutorPayload
): payload is UnixSyncBranchPayload {
  return payload.command === 'unix.sync-branch';
}

/**
 * Type guard for UnixSyncRepoPayload
 */
export function isUnixSyncRepoPayload(payload: ExecutorPayload): payload is UnixSyncRepoPayload {
  return payload.command === 'unix.sync-repo';
}

/**
 * Type guard for UnixSyncUserPayload
 */
export function isUnixSyncUserPayload(payload: ExecutorPayload): payload is UnixSyncUserPayload {
  return payload.command === 'unix.sync-user';
}

/**
 * Type guard for ZellijAttachPayload
 */
export function isZellijAttachPayload(payload: ExecutorPayload): payload is ZellijAttachPayload {
  return payload.command === 'zellij.attach';
}

/**
 * Type guard for ZellijTabPayload
 */
export function isZellijTabPayload(payload: ExecutorPayload): payload is ZellijTabPayload {
  return payload.command === 'zellij.tab';
}
