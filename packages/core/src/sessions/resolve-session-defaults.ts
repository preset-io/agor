/**
 * Session creation config resolution
 *
 * Single source of truth for "given a user (and optional overrides), what
 * permission_config / model_config / mcp_server_ids should this new session
 * be stamped with?"
 *
 * This collapses the resolution dance that was duplicated across:
 * - `apps/agor-daemon/src/mcp/tools/sessions.ts`   (`agor_sessions_create`)
 * - `apps/agor-daemon/src/mcp/tools/worktrees.ts`  (`agor_worktrees_set_zone`)
 * - `apps/agor-daemon/src/services/gateway.ts`     (gateway session creation)
 * - `apps/agor-daemon/src/services/sessions.ts`    (cross-tool spawn fallback)
 * - `apps/agor-daemon/src/utils/apply-session-config-defaults.ts` (the
 *   `before:create` hook, which applies these defaults to ANY caller — UI
 *   drag-into-zone, raw REST, etc. — that omits permission/model config)
 *
 * Resolution order (highest priority first):
 *   1. `overrides.*`         — explicit caller intent
 *   2. `user.default_agentic_config[tool].*`  — user's saved default for this tool
 *   3. Hardcoded `getDefaultPermissionMode(tool)` (permission only) /
 *      `undefined` (model)
 *
 * MCP server inheritance (separate axis):
 *   1. `overrides.mcpServerIds`  — explicit (incl. empty array = "no MCPs")
 *   2. `worktree.mcp_server_ids` — worktree-level override
 *   3. `user.default_agentic_config[tool].mcpServerIds`
 *   4. `[]`
 */

import {
  type ModelConfigInput,
  type ResolvedModelConfig,
  resolveModelConfig,
} from '../models/resolve-config.js';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexNetworkAccess,
  CodexSandboxMode,
  PermissionMode,
  Session,
  User,
} from '../types/index.js';
import { getDefaultPermissionMode } from '../types/session.js';
import { mapPermissionMode } from '../utils/permission-mode-mapper.js';

/** Explicit per-call overrides. Each field, when defined, wins over user defaults. */
export interface SessionDefaultsOverrides {
  permissionMode?: PermissionMode;
  modelConfig?: ModelConfigInput;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: CodexNetworkAccess;
  /**
   * Explicit MCP server ID list. An empty array means "no MCPs" — does NOT
   * fall through to worktree/user defaults. Pass `undefined` to fall through.
   */
  mcpServerIds?: string[];
}

export interface ResolveSessionDefaultsArgs {
  agenticTool: AgenticToolName;
  /** User whose `default_agentic_config[tool]` provides the next-priority defaults. */
  user?: Pick<User, 'default_agentic_config'> | null;
  /** Optional worktree for MCP server inheritance (worktree-level overrides user defaults). */
  worktree?: { mcp_server_ids?: string[] | null } | null;
  overrides?: SessionDefaultsOverrides;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
}

export interface ResolvedSessionDefaults {
  /** Always populated — falls back to `getDefaultPermissionMode(tool)` mapped through `mapPermissionMode`. */
  permission_config: NonNullable<Session['permission_config']>;
  /** Optional — `undefined` when neither overrides nor user defaults specify a model. */
  model_config?: ResolvedModelConfig;
  /** Resolved MCP server list. Empty array means "no MCPs". */
  mcp_server_ids: string[];
}

/**
 * Resolve session creation defaults from caller overrides + user defaults.
 *
 * The returned `permission_config` is always populated (using the system
 * fallback when nothing else applies), so callers can persist it directly.
 * `model_config` may be `undefined` when no model has been chosen anywhere.
 */
export function resolveSessionDefaults(args: ResolveSessionDefaultsArgs): ResolvedSessionDefaults {
  const { agenticTool, user, worktree, overrides, now } = args;
  const userToolDefaults = user?.default_agentic_config?.[agenticTool];

  // ---- permission_config ----
  // Walk: explicit override → user default → hardcoded fallback.
  const requestedMode: PermissionMode =
    overrides?.permissionMode ??
    userToolDefaults?.permissionMode ??
    getDefaultPermissionMode(agenticTool);
  const permissionMode = mapPermissionMode(requestedMode, agenticTool);

  const permission_config: NonNullable<Session['permission_config']> = {
    mode: permissionMode,
  };

  // Codex's dual permission config: explicit overrides win as a unit; otherwise
  // copy user defaults if both required fields are present (legacy behavior).
  if (agenticTool === 'codex') {
    const sandboxMode = overrides?.codexSandboxMode ?? userToolDefaults?.codexSandboxMode;
    const approvalPolicy = overrides?.codexApprovalPolicy ?? userToolDefaults?.codexApprovalPolicy;
    const networkAccess = overrides?.codexNetworkAccess ?? userToolDefaults?.codexNetworkAccess;
    if (sandboxMode && approvalPolicy) {
      permission_config.codex = {
        sandboxMode,
        approvalPolicy,
        ...(networkAccess !== undefined && { networkAccess }),
      };
    }
  }

  // ---- model_config ----
  const model_config =
    resolveModelConfig(overrides?.modelConfig, { now }) ??
    resolveModelConfig(userToolDefaults?.modelConfig, { now });

  // ---- mcp_server_ids ----
  // Explicit override wins (incl. empty array = "no MCPs"). Otherwise:
  // worktree config > user defaults > [].
  let mcp_server_ids: string[];
  if (overrides?.mcpServerIds !== undefined) {
    mcp_server_ids = overrides.mcpServerIds;
  } else if (worktree?.mcp_server_ids && worktree.mcp_server_ids.length > 0) {
    mcp_server_ids = worktree.mcp_server_ids;
  } else {
    mcp_server_ids = userToolDefaults?.mcpServerIds ?? [];
  }

  return { permission_config, model_config, mcp_server_ids };
}
