/**
 * Child-session config resolution (fork / spawn / subsession)
 *
 * Single source of truth for "given a parent session and a child request,
 * what permission_config / model_config should the child be stamped with?"
 *
 * Why this exists separately from {@link resolveSessionDefaults}:
 * - `resolveSessionDefaults` answers "no parent — what defaults apply?"
 *   (used by direct create, zone trigger, gateway, and the before:create hook).
 * - `resolveChildSessionConfig` answers "I have a parent — when should the
 *   child inherit from it vs. fall back to the user's per-tool default?"
 *
 * The resolution rule, in one place
 * ---------------------------------
 * Each config field is resolved independently:
 *
 *   model_config:
 *     1. explicit request override                         (always wins)
 *     2. parent.model_config IF parent.agentic_tool === effectiveTool
 *     3. user.default_agentic_config[effectiveTool].modelConfig
 *     4. undefined                                          (system has no model fallback)
 *
 *   permission_config:
 *     1. explicit request override (incl. codex sub-config)
 *     2. parent.permission_config IF parent.agentic_tool === effectiveTool
 *     3. user.default_agentic_config[effectiveTool].permissionMode (mapped)
 *     4. getDefaultPermissionMode(effectiveTool) (mapped)
 *
 * The cross-tool gate at step 2 is the bug fix: if the child's tool differs
 * from the parent's, parent config is *meaningless* — a Claude model name
 * cannot run on Codex, and Claude's `acceptEdits` mode does not exist for
 * Codex. The old code carried `parent.model_config` through as a fallback
 * when the user had no per-tool default, so Codex children spawned from
 * Claude parents inherited a Claude model and the SDK errored.
 *
 * MCP server inheritance is a separate axis and lives at the call site —
 * MCPs are tool-agnostic and the existing "explicit list > copy from parent"
 * behavior is correct regardless of tool match.
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
  DefaultAgenticToolConfig,
  PermissionMode,
  Session,
  User,
} from '../types/index.js';
import { getDefaultPermissionMode } from '../types/session.js';
import { mapPermissionMode } from '../utils/permission-mode-mapper.js';

/** Explicit overrides from the spawn/fork request. */
export interface ChildSessionOverrides {
  permissionMode?: PermissionMode;
  modelConfig?: ModelConfigInput;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: CodexNetworkAccess;
}

/** Minimal parent shape this resolver reads — keeps tests free of full Session fixtures. */
export type ChildResolverParent = Pick<
  Session,
  'agentic_tool' | 'permission_config' | 'model_config'
>;

export interface ResolveChildSessionConfigArgs {
  /** Required — the parent session this child is forking/spawning from. */
  parent: ChildResolverParent;
  /** The child's agentic tool. Defaults to `parent.agentic_tool` when omitted. */
  effectiveTool?: AgenticToolName;
  /** User whose per-tool defaults are used when parent inheritance is gated off. */
  user?: Pick<User, 'default_agentic_config'> | null;
  /** Explicit per-call overrides from the spawn/fork request. */
  overrides?: ChildSessionOverrides;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
}

export interface ResolvedChildSessionConfig {
  /** Always populated — falls through request → parent (same tool) → user-default → mapped system default. */
  permission_config: NonNullable<Session['permission_config']>;
  /** May be `undefined` when no model is set anywhere appropriate for the effective tool. */
  model_config?: ResolvedModelConfig;
}

/**
 * Resolve `permission_config` and `model_config` for a child session.
 *
 * See file-level doc-comment for the precedence rule. This helper does NOT
 * resolve MCP server IDs — those are handled at the call site (parent-copy
 * vs. explicit override is independent of tool match).
 */
export function resolveChildSessionConfig(
  args: ResolveChildSessionConfigArgs
): ResolvedChildSessionConfig {
  const { parent, user, overrides, now } = args;
  const effectiveTool: AgenticToolName = args.effectiveTool ?? parent.agentic_tool;
  const sameTool = effectiveTool === parent.agentic_tool;
  const userToolDefaults = user?.default_agentic_config?.[effectiveTool];

  // ---- model_config ----
  // Explicit > parent (gated on tool match) > user default > undefined.
  // The tool gate is the bug fix: a Claude model cannot run on Codex, so
  // we drop the parent fallback when the child crosses tools.
  const inheritedParentModel: ModelConfigInput | undefined = sameTool
    ? parent.model_config
    : undefined;

  const model_config =
    resolveModelConfig(overrides?.modelConfig, { now }) ??
    resolveModelConfig(inheritedParentModel, { now }) ??
    resolveModelConfig(userToolDefaults?.modelConfig, { now });

  // ---- permission_config ----
  // Explicit > parent (gated on tool match) > user default > system default.
  // For cross-tool spawns we never inherit parent.permission_config —
  // Claude's `acceptEdits` is not a valid Codex mode, and Codex's `codex`
  // sub-config is missing on Claude parents anyway. The resolver always
  // produces a populated permission_config.
  const permission_config = resolveChildPermissionConfig({
    effectiveTool,
    sameTool,
    parentPermission: parent.permission_config,
    userToolDefaults,
    overrides,
  });

  return { permission_config, model_config };
}

/**
 * Resolve `permission_config` for a child session.
 *
 * Split out so the precedence walk is readable: each branch is a single
 * "do we have a value at this priority?" check.
 */
function resolveChildPermissionConfig(args: {
  effectiveTool: AgenticToolName;
  sameTool: boolean;
  parentPermission: Session['permission_config'];
  userToolDefaults: DefaultAgenticToolConfig | undefined;
  overrides?: ChildSessionOverrides;
}): NonNullable<Session['permission_config']> {
  const { effectiveTool, sameTool, parentPermission, userToolDefaults, overrides } = args;

  // ---- mode ----
  // Explicit > parent (same tool only) > user default > system default.
  let resolvedMode: PermissionMode | undefined = overrides?.permissionMode;
  if (!resolvedMode && sameTool && parentPermission?.mode) {
    resolvedMode = parentPermission.mode;
  }
  if (!resolvedMode) {
    resolvedMode = userToolDefaults?.permissionMode ?? getDefaultPermissionMode(effectiveTool);
  }
  const mode = mapPermissionMode(resolvedMode, effectiveTool);

  const out: NonNullable<Session['permission_config']> = { mode };

  // ---- codex sub-config (only on codex children) ----
  // Explicit fields > parent's codex sub-config (only when same tool) > user defaults.
  if (effectiveTool === 'codex') {
    const sandboxMode =
      overrides?.codexSandboxMode ??
      (sameTool ? parentPermission?.codex?.sandboxMode : undefined) ??
      userToolDefaults?.codexSandboxMode;
    const approvalPolicy =
      overrides?.codexApprovalPolicy ??
      (sameTool ? parentPermission?.codex?.approvalPolicy : undefined) ??
      userToolDefaults?.codexApprovalPolicy;
    const networkAccessExplicit = overrides?.codexNetworkAccess;
    const networkAccessParent = sameTool ? parentPermission?.codex?.networkAccess : undefined;
    const networkAccess =
      networkAccessExplicit !== undefined
        ? networkAccessExplicit
        : (networkAccessParent ?? userToolDefaults?.codexNetworkAccess);

    if (sandboxMode && approvalPolicy) {
      out.codex = {
        sandboxMode,
        approvalPolicy,
        ...(networkAccess !== undefined && { networkAccess }),
      };
    }
  }

  return out;
}
