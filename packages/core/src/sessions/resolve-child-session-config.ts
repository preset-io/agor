/**
 * Child-session config resolution (fork / spawn / subsession).
 *
 * Sibling of {@link resolveSessionDefaults} — same precedence walk, plus a
 * tool-gated parent layer interposed between explicit overrides and user
 * defaults.
 *
 *   model_config:      request → parent (same tool only) → user default → undefined
 *   permission_config: request → parent (same tool only) → user default → mapped system default
 *
 * The "same tool only" gate is the bug fix: a Claude model cannot run on
 * Codex, and Claude's `acceptEdits` mode does not exist for Codex. Without
 * the gate, Codex children spawned from Claude parents inherit a Claude
 * model and the SDK errors.
 *
 * MCP server inheritance is a separate axis handled at the spawn call site —
 * MCPs are tool-agnostic and follow "explicit list > copy from parent"
 * regardless of tool match.
 */

import { resolveModelConfigPrecedence } from '../models/resolve-config.js';
import type { AgenticToolName, Session, User } from '../types/index.js';
import {
  type ParentPermissionLayer,
  resolvePermissionConfig,
  type SessionRuntimeOverrides,
} from './resolve-permission-config.js';

/** Explicit overrides from the spawn/fork request. */
export type ChildSessionOverrides = SessionRuntimeOverrides;

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
  /** User whose per-tool defaults apply when the parent layer is gated off. */
  user?: Pick<User, 'default_agentic_config'> | null;
  overrides?: ChildSessionOverrides;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
}

export interface ResolvedChildSessionConfig {
  /** Always populated. */
  permission_config: NonNullable<Session['permission_config']>;
  /** May be `undefined` when no model is set anywhere appropriate for the effective tool. */
  model_config?: NonNullable<Session['model_config']>;
}

export function resolveChildSessionConfig(
  args: ResolveChildSessionConfigArgs
): ResolvedChildSessionConfig {
  const { parent, user, overrides, now } = args;
  const effectiveTool: AgenticToolName = args.effectiveTool ?? parent.agentic_tool;
  const sameTool = effectiveTool === parent.agentic_tool;
  const userToolDefaults = user?.default_agentic_config?.[effectiveTool];

  // Build the parent layer only when same-tool — the cross-tool gate.
  const parentLayer: ParentPermissionLayer | undefined = sameTool
    ? {
        permissionMode: parent.permission_config?.mode,
        codexSandboxMode: parent.permission_config?.codex?.sandboxMode,
        codexApprovalPolicy: parent.permission_config?.codex?.approvalPolicy,
        codexNetworkAccess: parent.permission_config?.codex?.networkAccess,
      }
    : undefined;

  const permission_config = resolvePermissionConfig({
    effectiveTool,
    overrides,
    userToolDefaults,
    parentLayer,
  });

  // model_config: explicit > parent (same tool only) > user default > undefined.
  const model_config = resolveModelConfigPrecedence(
    [
      overrides?.modelConfig,
      sameTool ? parent.model_config : undefined,
      userToolDefaults?.modelConfig,
    ],
    { now }
  );

  return { permission_config, model_config };
}
