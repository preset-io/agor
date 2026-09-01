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
import {
  ENVIRONMENT_STARTUP_TIMEOUT_MAX_MS,
  ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS,
} from '@agor/core/environment/health-transition';
import {
  type ExecutorCommandResult,
  ExecutorCommandResultSchema,
  ExecutorResponseDescriptorSchema,
} from '@agor/core/executor-protocol';
import { AGENTIC_TOOL_NAMES, type AgenticToolName } from '@agor/core/types';
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
export const ToolTypeSchema = z.enum(AGENTIC_TOOL_NAMES);
export type ToolType = AgenticToolName;

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
 * NOTE: Delegated launcher identity is not in the payload. It is handled at
 * spawn time by the daemon and external launcher.
 */
export const BasePayloadSchema = z.object({
  /** Executor command identifier */
  command: z.string(),

  /** Invocation lifecycle selected by the daemon host. */
  executorMode: z.enum(['autonomous', 'request']).optional(),

  /** One-attempt callback capability. Required when executorMode=request. */
  executorResponse: ExecutorResponseDescriptorSchema.optional(),

  /** Daemon URL for Feathers connection */
  daemonUrl: z.string().url().optional(),

  /** Environment variables to inject */
  env: z.record(z.string(), z.string()).optional(),

  /** Opaque, daemon-authorized context interpreted by the selected adapter. */
  agenticToolContext: z.record(z.string(), z.unknown()).optional(),

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
// Agentic-tool Auxiliary Invocation Payload
// ═══════════════════════════════════════════════════════════

export const AgenticToolInvokePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('agentic-tool.invoke'),
  params: z.object({
    tool: ToolTypeSchema,
    /** Adapter-owned request validated by the selected integration. */
    request: z.record(z.string(), z.unknown()),
  }),
});

export type AgenticToolInvokePayload = z.infer<typeof AgenticToolInvokePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Clone Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git clone payload.
 *
 * When createDbRecord is true (default), the executor will:
 * 1. Clone the repository to outputPath
 * 2. Create a repo record in the database via Feathers
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
     * Import executable environment configuration from the cloned
     * `.agor.yml`. This capability is derived by the daemon from the
     * initiating user's admin role and defaults closed for direct callers.
     */
    importEnvironmentConfig: z.boolean().optional().default(false),

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
 * 2. Patches the branch record to filesystem_status: 'ready' (or 'failed')
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
export const GitBranchAddPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.branch.add'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Branch ID (UUID) - DB record already exists with filesystem_status: 'creating' */
    branchId: z.string().uuid(),

    /** Repo ID (UUID) */
    repoId: z.string().uuid(),

    /** Use restore mode: smart branch detection via ls-remote, falls back to creating from sourceBranch */
    restoreMode: z.boolean().optional(),

    /** User ID of the requesting user (for per-user credential resolution) */
    userId: z.string().uuid().optional(),

    /** Whether clone mode may use the tenant-fetched repo path as an object-cache hint. */
    useReference: z.boolean().optional().default(false),
  }),
});

export type GitBranchAddPayload = z.infer<typeof GitBranchAddPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Branch Remove Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git branch remove payload — remove only daemon-authorized filesystem state.
 * Branch metadata and cascades remain entirely daemon-owned.
 */
export const GitBranchRemovePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.branch.remove'),
  params: z.object({
    /** Branch ID (UUID) retained for bounded diagnostics. */
    branchId: z.string().uuid(),

    /** Path to the branch to remove */
    branchPath: z.string(),

    /** Tenant-aware root that must contain branchPath */
    branchesRoot: z.string(),

    /** Force removal even if dirty */
    force: z.boolean().optional(),

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
  params: z.object({
    /** Path to the branch to clean */
    branchPath: z.string(),
  }),
});

export type GitBranchCleanPayload = z.infer<typeof GitBranchCleanPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Branch Files List Payload
// ═══════════════════════════════════════════════════════════

/**
 * Branch files list payload - list tracked files/folders for autocomplete.
 */
export const BranchFilesListPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.files.list'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Branch ID whose checkout should be inspected */
    branchId: z.string().uuid(),

    /** Case-insensitive substring query */
    search: z.string(),

    /** Max combined file/folder results */
    limit: z.number().int().positive().max(100).optional().default(10),
  }),
});

export type BranchFilesListPayload = z.infer<typeof BranchFilesListPayloadSchema>;

export const BranchFilesBrowsePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.files.browse'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
  }),
});

export type BranchFilesBrowsePayload = z.infer<typeof BranchFilesBrowsePayloadSchema>;

export const BranchFilesReadPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.files.read'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    filePath: z.string().min(1),
  }),
});

export type BranchFilesReadPayload = z.infer<typeof BranchFilesReadPayloadSchema>;

export const BranchFilesystemStatusPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.filesystem.status'),
  sessionToken: z.string(),
  params: z
    .object({
      branchId: z.string().uuid().optional(),
      branchIds: z.array(z.string().uuid()).max(10000).optional(),
    })
    .refine((value) => value.branchId !== undefined || value.branchIds !== undefined, {
      message: 'branchId or branchIds is required',
    }),
});

export type BranchFilesystemStatusPayload = z.infer<typeof BranchFilesystemStatusPayloadSchema>;

export const BranchArtifactPublishPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.artifact.publish'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    subpath: z.string().min(1),
    publishData: z.record(z.string(), z.unknown()),
  }),
});

export type BranchArtifactPublishPayload = z.infer<typeof BranchArtifactPublishPayloadSchema>;

export const BranchArtifactLandPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.artifact.land'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    artifactId: z.string().uuid(),
    subpath: z.string().optional(),
    overwrite: z.boolean().optional(),
  }),
});

export type BranchArtifactLandPayload = z.infer<typeof BranchArtifactLandPayloadSchema>;

export const BranchArtifactValidatePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.artifact.validate'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    subpath: z.string().min(1),
  }),
});

export type BranchArtifactValidatePayload = z.infer<typeof BranchArtifactValidatePayloadSchema>;

export const BranchKnowledgeWritePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.knowledge.write'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    subpath: z.string().min(1),
    content: z.string(),
    sidecar: z.record(z.string(), z.unknown()),
    overwrite: z.boolean().optional(),
  }),
});
export type BranchKnowledgeWritePayload = z.infer<typeof BranchKnowledgeWritePayloadSchema>;

export const BranchKnowledgeReadPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.knowledge.read'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    subpath: z.string().min(1),
  }),
});
export type BranchKnowledgeReadPayload = z.infer<typeof BranchKnowledgeReadPayloadSchema>;

export const BranchSlackFileUploadPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.gateway.slack-file-upload'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    filePath: z.string().min(1),
    gatewayChannelId: z.string().uuid(),
    channel: z.string().min(1),
    threadTs: z.string().optional(),
    filename: z.string().optional(),
    comment: z.string().optional(),
    maxBytes: z.number().int().positive(),
  }),
});
export type BranchSlackFileUploadPayload = z.infer<typeof BranchSlackFileUploadPayloadSchema>;

export const BranchUploadMaterializePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.upload.materialize'),
  sessionToken: z.string(),
  params: z.object({
    branchId: z.string().uuid(),
    sessionId: z.string().uuid(),
    uploadRef: z.string().regex(/^upl_[0-9a-f-]{36}$/),
    filename: z.string().min(1),
  }),
});
export type BranchUploadMaterializePayload = z.infer<typeof BranchUploadMaterializePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Branch .agor.yml Payloads
// ═══════════════════════════════════════════════════════════

/**
 * Import branch-scoped .agor.yml from a managed branch checkout.
 */
export const BranchAgorYmlImportPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.agor-yml.import'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repo ID the branch must belong to */
    repoId: z.string().uuid(),

    /** Branch ID whose checkout should be read */
    branchId: z.string().uuid(),
  }),
});

export type BranchAgorYmlImportPayload = z.infer<typeof BranchAgorYmlImportPayloadSchema>;

/**
 * Export environment config into branch-scoped .agor.yml in a managed checkout.
 */
export const BranchAgorYmlExportPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('branch.agor-yml.export'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repo ID the branch must belong to */
    repoId: z.string().uuid(),

    /** Branch ID whose checkout should be written */
    branchId: z.string().uuid(),

    /** Environment config to serialize */
    environment: z.unknown(),
  }),
});

export type BranchAgorYmlExportPayload = z.infer<typeof BranchAgorYmlExportPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Environment Lifecycle Payload
// ═══════════════════════════════════════════════════════════

/**
 * Environment lifecycle payload - run shell-based start/stop/restart/nuke
 * commands from the executor. Webhook lifecycle commands stay daemon-owned.
 */
export const EnvironmentLifecyclePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('environment.lifecycle'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z
    .object({
      /** Branch ID whose environment is being controlled */
      branchId: z.string().uuid(),

      /** Branch checkout path. Executor refetches the branch but this avoids ambiguity. */
      branchPath: z.string().optional(),

      /** Lifecycle action */
      action: z.enum(['start', 'stop', 'restart', 'nuke', 'sync']),

      /** Shell start command. Required for start/restart. */
      startCommand: z.string().optional(),

      /** Shell stop command. Required for stop and used before restart when present. */
      stopCommand: z.string().optional(),

      /** Shell nuke command. Required for nuke. */
      nukeCommand: z.string().optional(),

      /** Shell sync command. Required for sync. Pushes the branch's latest code
       *  into the running remote environment (see RepoEnvironmentVariant.sync). */
      syncCommand: z.string().optional(),

      /** Static app URL rendered by the daemon/branch snapshot. */
      appUrl: z.string().optional(),

      /** Static health URL rendered by the daemon/branch snapshot. */
      healthCheckUrl: z.string().optional(),

      /** Wall-clock budget for a start attempt, snapshotted by the daemon. */
      startupTimeoutMs: z
        .number()
        .int()
        .min(ENVIRONMENT_STARTUP_TIMEOUT_MIN_MS)
        .max(ENVIRONMENT_STARTUP_TIMEOUT_MAX_MS)
        .optional(),

      /** Monotonic lifecycle boundary that must still own every state update. */
      lifecycleGeneration: z.number().int().nonnegative().optional(),
    })
    .superRefine((params, ctx) => {
      if ((params.action === 'start' || params.action === 'restart') && !params.startCommand) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['startCommand'],
          message: 'startCommand is required for start/restart',
        });
      }
      if (params.action === 'stop' && !params.stopCommand) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stopCommand'],
          message: 'stopCommand is required for stop',
        });
      }
      if (params.action === 'nuke' && !params.nukeCommand) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nukeCommand'],
          message: 'nukeCommand is required for nuke',
        });
      }
    }),
});

export type EnvironmentLifecyclePayload = z.infer<typeof EnvironmentLifecyclePayloadSchema>;

/**
 * Environment logs payload - run shell-based logs command from executor.
 * Webhook logs stay daemon-owned.
 */
export const EnvironmentLogsPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('environment.logs'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Branch ID whose environment logs are being fetched */
    branchId: z.string().uuid(),

    /** Branch checkout path. Executor refetches the branch but this avoids ambiguity. */
    branchPath: z.string().optional(),

    /** Shell logs command */
    logsCommand: z.string(),
  }),
});

export type EnvironmentLogsPayload = z.infer<typeof EnvironmentLogsPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Repo Realign Origin Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git repo origin realign payload - ensure remote.origin.url matches DB.
 */
export const GitRepoRealignOriginPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.repo.realign-origin'),
  params: z.object({
    /** Repo identity retained for bounded diagnostics. */
    repoId: z.string().uuid(),
    /** Daemon-authoritative managed repository path. */
    repoPath: z.string().min(1),
    /** Daemon-authoritative canonical origin URL. */
    remoteUrl: z.string().min(1),
    /** Redacted human-readable identifier for the security log. */
    repoSlug: z.string().min(1),
  }),
});

export type GitRepoRealignOriginPayload = z.infer<typeof GitRepoRealignOriginPayloadSchema>;

export const GitRepoInspectPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.repo.inspect'),
  params: z.object({
    path: z.string().min(1),
  }),
});
export type GitRepoInspectPayload = z.infer<typeof GitRepoInspectPayloadSchema>;

export const GitManagedCredentialsReconcilePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.managed-credentials.reconcile'),
  sessionToken: z.string(),
  params: z.object({}),
});
export type GitManagedCredentialsReconcilePayload = z.infer<
  typeof GitManagedCredentialsReconcilePayloadSchema
>;

// ═══════════════════════════════════════════════════════════
// Git Repo Delete Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git repo delete payload - remove managed repo + branch directories.
 * The daemon deletes DB rows only after this command succeeds.
 */
export const GitRepoDeletePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.repo.delete'),

  params: z.object({
    /** Repo being deleted (diagnostic attribution only). */
    repoId: z.string().uuid(),
    /** Daemon-authoritative managed repository path. */
    repoPath: z.string().min(1),
    /** Daemon-authoritative managed branch paths from the unbounded inventory. */
    branchPaths: z.array(z.string().min(1)),
    /** Tenant-scoped root that is allowed to contain the managed repository. */
    reposRoot: z.string().min(1),
    /** Tenant-scoped root that is allowed to contain managed branches. */
    branchesRoot: z.string().min(1),
  }),
});

export type GitRepoDeletePayload = z.infer<typeof GitRepoDeletePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Zellij Payloads
// ═══════════════════════════════════════════════════════════

/**
 * Zellij attach payload - attach to or create Zellij session
 *
 * This spawns a PTY, runs zellij attach, and streams I/O over Feathers channels.
 * One executor per process-local, branch-scoped terminal attachment.
 */
export const ZellijAttachPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('zellij.attach'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** User ID used by the daemon to derive an opaque tenant-qualified terminal channel. */
    userId: z.string().uuid(),

    /** Opaque process-local attachment id returned to the browser. */
    terminalId: z.string().uuid(),

    /** Tenant/user/terminal-qualified owner-local Socket.IO room. */
    channel: z.string().min(1),

    /** Zellij session name (e.g., "agor-max") */
    sessionName: z.string(),

    /** Initial working directory */
    cwd: z.string().optional(),

    /** Initial tab name (branch name) */
    tabName: z.string().optional(),

    /** Terminal dimensions */
    cols: z.number().optional().default(80),
    rows: z.number().optional().default(24),
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
    action: z.enum(['create', 'focus']),

    /** Tab name (branch name) */
    tabName: z.string(),

    /** Working directory (for 'create' action) */
    cwd: z.string().optional(),
  }),
});

export type ZellijTabPayload = z.infer<typeof ZellijTabPayloadSchema>;

/**
 * Narrow user-runtime credential filesystem operation. The daemon resolves the
 * credential route before launch; no username or path is accepted in the
 * payload.
 */
export const CodexAuthFilePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('codex.auth-file'),
  params: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('inspect') }),
    z.object({
      operation: z.literal('write'),
      content: z.string().max(64 * 1024),
      generation: z.number().int().positive().optional(),
    }),
    z.object({
      operation: z.literal('delete'),
      generation: z.number().int().positive().optional(),
    }),
  ]),
});

export type CodexAuthFilePayload = z.infer<typeof CodexAuthFilePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Union Payload Type
// ═══════════════════════════════════════════════════════════

/**
 * All supported executor payloads
 */
const ExecutorPayloadUnionSchema = z.discriminatedUnion('command', [
  PromptPayloadSchema,
  AgenticToolInvokePayloadSchema,
  GitClonePayloadSchema,
  GitBranchAddPayloadSchema,
  GitBranchRemovePayloadSchema,
  GitBranchCleanPayloadSchema,
  BranchFilesListPayloadSchema,
  BranchFilesBrowsePayloadSchema,
  BranchFilesReadPayloadSchema,
  BranchFilesystemStatusPayloadSchema,
  BranchArtifactPublishPayloadSchema,
  BranchArtifactLandPayloadSchema,
  BranchArtifactValidatePayloadSchema,
  BranchKnowledgeWritePayloadSchema,
  BranchKnowledgeReadPayloadSchema,
  BranchSlackFileUploadPayloadSchema,
  BranchUploadMaterializePayloadSchema,
  BranchAgorYmlImportPayloadSchema,
  BranchAgorYmlExportPayloadSchema,
  EnvironmentLifecyclePayloadSchema,
  EnvironmentLogsPayloadSchema,
  GitRepoRealignOriginPayloadSchema,
  GitRepoInspectPayloadSchema,
  GitManagedCredentialsReconcilePayloadSchema,
  GitRepoDeletePayloadSchema,
  ZellijAttachPayloadSchema,
  ZellijTabPayloadSchema,
  CodexAuthFilePayloadSchema,
]);

export const ExecutorPayloadSchema = ExecutorPayloadUnionSchema.superRefine((payload, ctx) => {
  if (payload.executorMode === 'request' && !payload.executorResponse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executorResponse'],
      message: 'executorMode=request requires an executor response descriptor',
    });
  }
  if (payload.executorMode !== 'request' && payload.executorResponse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executorResponse'],
      message: 'executor response descriptors are valid only in request mode',
    });
  }
});

export type ExecutorPayload = z.infer<typeof ExecutorPayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Executor Result
// ═══════════════════════════════════════════════════════════

/**
 * Executor result returned through the authenticated response channel.
 */
export const ExecutorResultSchema = ExecutorCommandResultSchema;

export type ExecutorResult = ExecutorCommandResult;

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
    'agentic-tool.invoke',
    'git.clone',
    'git.branch.add',
    'git.branch.remove',
    'git.branch.clean',
    'git.repo.inspect',
    'git.managed-credentials.reconcile',
    'branch.files.list',
    'branch.files.browse',
    'branch.files.read',
    'branch.filesystem.status',
    'branch.artifact.publish',
    'branch.artifact.land',
    'branch.artifact.validate',
    'branch.knowledge.write',
    'branch.knowledge.read',
    'branch.gateway.slack-file-upload',
    'branch.upload.materialize',
    'branch.agor-yml.import',
    'branch.agor-yml.export',
    'environment.lifecycle',
    'environment.logs',
    'git.repo.realign-origin',
    'git.repo.delete',
    'zellij.attach',
    'zellij.tab',
    'codex.auth-file',
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
