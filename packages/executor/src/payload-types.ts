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
// Shared Schemas
// ═══════════════════════════════════════════════════════════

/**
 * Tool types supported by the prompt command
 */
export const ToolTypeSchema = z.enum(['claude-code', 'gemini', 'codex', 'opencode']);
export type ToolType = z.infer<typeof ToolTypeSchema>;

/**
 * Permission modes for agent execution
 * Note: 'default' is intentionally not included - if not specified,
 * the executor will use its default behavior (undefined)
 */
export const PermissionModeSchema = z.enum(['ask', 'auto', 'allow-all']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

// ═══════════════════════════════════════════════════════════
// Base Payload Schema
// ═══════════════════════════════════════════════════════════

/**
 * Base payload - common fields for all commands
 */
export const BasePayloadSchema = z.object({
  /** Executor command identifier */
  command: z.string(),

  /** Unix user to impersonate (optional) */
  asUser: z.string().optional(),

  /** Daemon URL for Feathers connection */
  daemonUrl: z.string().url().optional(),

  /** Environment variables to inject */
  env: z.record(z.string()).optional(),

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
 * 3. Initialize Unix group (if RBAC enabled)
 */
export const GitClonePayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.clone'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repository URL (https or ssh) */
    url: z.string().url(),

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
  }),
});

export type GitClonePayload = z.infer<typeof GitClonePayloadSchema>;

// ═══════════════════════════════════════════════════════════
// Git Worktree Add Payload
// ═══════════════════════════════════════════════════════════

/**
 * Git worktree add payload - create worktree with full Unix setup
 *
 * When createDbRecord is true (default), the executor will:
 * 1. Create the git worktree at worktreePath
 * 2. Create a worktree record in the database via Feathers
 * 3. Set up Unix group/ACLs (if RBAC enabled)
 */
export const GitWorktreeAddPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('git.worktree.add'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Repo ID (UUID) - required for DB record creation */
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

    /** Board ID to associate worktree with (optional) */
    boardId: z.string().uuid().optional(),

    /** Create DB record after worktree creation (default: true) */
    createDbRecord: z.boolean().optional().default(true),
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
// Zellij Attach Payload
// ═══════════════════════════════════════════════════════════

/**
 * Zellij attach payload - attach to or create Zellij session
 */
export const ZellijAttachPayloadSchema = BasePayloadSchema.extend({
  command: z.literal('zellij.attach'),

  /** JWT for Feathers authentication */
  sessionToken: z.string(),

  params: z.object({
    /** Zellij session name */
    sessionName: z.string(),

    /** Working directory */
    cwd: z.string(),

    /** Tab name (worktree name) */
    tabName: z.string().optional(),

    /** Create session if doesn't exist */
    create: z.boolean().optional(),
  }),
});

export type ZellijAttachPayload = z.infer<typeof ZellijAttachPayloadSchema>;

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
  ZellijAttachPayloadSchema,
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
  return ['prompt', 'git.clone', 'git.worktree.add', 'git.worktree.remove', 'zellij.attach'];
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
 * Type guard for ZellijAttachPayload
 */
export function isZellijAttachPayload(payload: ExecutorPayload): payload is ZellijAttachPayload {
  return payload.command === 'zellij.attach';
}
