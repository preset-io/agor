/**
 * ExecutorPayload - The private API contract between daemon and executor
 *
 * This is NOT a public CLI interface. It's an RPC protocol that happens
 * to use subprocess + stdin as the transport.
 *
 * All commands connect to daemon via Feathers and do complete transactions
 * (filesystem + DB + events). Unix operations are internal to git commands.
 */

import { z } from 'zod';

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
export const ToolTypeSchema = z.enum(['claude-code', 'gemini', 'codex', 'opencode']);
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

    /** Create DB record after clone (default: true) */
    createDbRecord: z.boolean().optional().default(true),

    /** Initialize Unix group for repo isolation (default: false, requires RBAC enabled) */
    initUnixGroup: z.boolean().optional().default(false),

    /** Daemon Unix user to add to the repo group (for daemon access) */
    daemonUser: z.string().optional(),

    /** Creator's Unix username to add to the repo group (for owner access) */
    creatorUnixUsername: z.string().optional(),
  }),
});

export type GitClonePayload = z.infer<typeof GitClonePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Worktree Add Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git worktree add payload - create worktree filesystem
 *
 * The daemon creates the DB record BEFORE calling this (with filesystem_status: 'creating').
 * The executor:
 * 1. Creates the git worktree at worktreePath
 * 2. Sets up Unix group/ACLs (if initUnixGroup is true)
 * 3. Patches the worktree record to filesystem_status: 'ready' (or 'failed')
 */
export const GitWorktreeAddPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.worktree.add'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Worktree ID (UUID) - DB record already exists with filesystem_status: 'creating' */
    worktreeId: z.string().uuid(),

    /** Repo ID (UUID) */
    repoId: z.string().uuid(),

    /** Path to the repository */
    repoPath: z.string(),

    /** Name for the worktree */
    worktreeName: z.string(),

    /** Path where worktree will be created */
    worktreePath: z.string(),

    /** Branch to checkout or create */
    branch: z.string().optional(),

    /** Source branch when creating new branch */
    sourceBranch: z.string().optional(),

    /** Create new branch */
    createBranch: z.boolean().optional(),

    /** Type of ref (branch or tag) */
    refType: z.enum(['branch', 'tag']).optional(),

    /** Initialize Unix group for worktree isolation (default: false, requires RBAC enabled) */
    initUnixGroup: z.boolean().optional().default(false),

    /** Access level for non-owners ('none' | 'read' | 'write') */
    othersAccess: z.enum(['none', 'read', 'write']).optional().default('read'),

    /** Daemon Unix user to add to the worktree group (for daemon access) */
    daemonUser: z.string().optional(),

    /** Repo Unix group name (for fixing .git/worktrees permissions) */
    repoUnixGroup: z.string().optional(),

    /** Creator's Unix username to add to the worktree group (initial owner) */
    creatorUnixUsername: z.string().optional(),
  }),
});

export type GitWorktreeAddPayload = z.infer<typeof GitWorktreeAddPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Worktree Remove Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git worktree remove payload - remove worktree and cleanup Unix resources
 *
 * When deleteDbRecord is true (default), the executor will:
 * 1. Remove the git worktree from filesystem
 * 2. Delete the worktree record from database via Feathers
 * 3. Clean up Unix group/ACLs (if RBAC enabled)
 */
export const GitWorktreeRemovePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.worktree.remove'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Worktree ID (UUID) - required for DB record deletion */
    worktreeId: z.string().uuid(),

    /** Path to the worktree to remove */
    worktreePath: z.string(),

    /** Force removal even if dirty */
    force: z.boolean().optional(),

    /** Delete DB record after removal (default: true) */
    deleteDbRecord: z.boolean().optional().default(true),
  }),
});

export type GitWorktreeRemovePayload = z.infer<typeof GitWorktreeRemovePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Worktree Clean Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git worktree clean payload - remove untracked files and build artifacts
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
export const GitWorktreeCleanPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.worktree.clean'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Path to the worktree to clean */
    worktreePath: z.string(),
  }),
});

export type GitWorktreeCleanPayload = z.infer<typeof GitWorktreeCleanPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Unix Sync Payloads - High-Level Sync Operations
// ═══════════════════════════════════════════════════════════

/**
 * Unix sync-worktree payload - Sync all Unix state for a worktree
 *
 * This is a high-level "sync" operation that handles everything:
 * - Ensure worktree Unix group exists
 * - Set correct permissions based on others_fs_access
 * - Add all current owners to the worktree group
 * - Add owners to repo group (for .git/ access)
 * - Fix .git/worktrees/<name>/ permissions
 * - Create symlinks in user home directories
 *
 * Idempotent: Safe to call multiple times. Executor figures out the delta.
 * Fire-and-forget: Daemon calls this and returns immediately.
 */
export const UnixSyncWorktreePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('unix.sync-worktree'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Worktree ID to sync */
    worktreeId: z.string().uuid(),

    /** Daemon Unix user (added to all groups for daemon access) */
    daemonUser: z.string().optional(),

    /** If true, delete the group instead of syncing (for worktree removal) */
    delete: z.boolean().optional(),
  }),
});

export type UnixSyncWorktreePayload = z.infer<typeof UnixSyncWorktreePayloadSchema>;

/**
 * Unix sync-repo payload - Sync all Unix state for a repo
 *
 * This handles:
 * - Ensure repo Unix group exists
 * - Set correct permissions on .git/ directory
 * - Add all worktree owners to repo group
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
 * - Sync symlinks for all owned worktrees
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

    /** Initial tab name (worktree name) */
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
    /** Action: create new tab or focus existing */
    action: z.enum(['create', 'focus']),

    /** Tab name (worktree name) */
    tabName: z.string(),

    /** Working directory (for 'create' action) */
    cwd: z.string().optional(),
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
  GitWorktreeAddPayloadSchema,
  GitWorktreeRemovePayloadSchema,
  GitWorktreeCleanPayloadSchema,
  UnixSyncWorktreePayloadSchema,
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
    'git.worktree.add',
    'git.worktree.remove',
    'git.worktree.clean',
    'unix.sync-worktree',
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
 * Type guard for GitWorktreeAddPayload
 */
export function isGitWorktreeAddPayload(
  payload: ExecutorPayload
): payload is GitWorktreeAddPayload {
  return payload.command === 'git.worktree.add';
}

/**
 * Type guard for GitWorktreeRemovePayload
 */
export function isGitWorktreeRemovePayload(
  payload: ExecutorPayload
): payload is GitWorktreeRemovePayload {
  return payload.command === 'git.worktree.remove';
}

/**
 * Type guard for GitWorktreeCleanPayload
 */
export function isGitWorktreeCleanPayload(
  payload: ExecutorPayload
): payload is GitWorktreeCleanPayload {
  return payload.command === 'git.worktree.clean';
}

/**
 * Type guard for UnixSyncWorktreePayload
 */
export function isUnixSyncWorktreePayload(
  payload: ExecutorPayload
): payload is UnixSyncWorktreePayload {
  return payload.command === 'unix.sync-worktree';
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
