/**
 * Session creation config resolution.
 *
 * Pure resolution engine used by the asynchronous agentic configuration
 * materializer. Runtime call sites select exactly one source and let that
 * materializer own persistence.
 *
 * Resolution order:
 *   permission_config: source → same-tool parent → execution owner →
 *                      mapped system default
 *   model_config:      source → same-tool parent → execution owner →
 *                      tool default (always
 *                      populated for tools with a static default; only
 *                      `undefined` for cursor; OpenCode fails closed when no
 *                      exact provider/model pair resolves)
 *   mcp_server_ids:    explicit list → branch → execution owner → []
 *
 * Child-session callers supply `parent`; the resolver gates its values on an
 * exact tool match. {@link resolveChildSessionConfig} is the narrow adapter.
 */

import {
  InvalidModelConfigError,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  resolveModelConfigWithFallback,
} from '../models/resolve-config.js';
import type { AgenticToolName, DefaultAgenticToolConfig, Session, User } from '../types/index.js';
import { canonicalTenantAgenticTool } from '../types/index.js';
import { resolvePermissionConfig } from './resolve-permission-config.js';

export interface ResolveSessionDefaultsArgs {
  agenticTool: AgenticToolName;
  /** User whose agentic and MCP defaults provide the next-priority defaults. */
  user?: Pick<User, 'default_agentic_config' | 'default_mcp_server_ids'> | null;
  /** The one selected inline or referenced configuration source. */
  source?: DefaultAgenticToolConfig | null;
  /**
   * Child-only fallback after the referenced configuration. Values are
   * ignored when the parent and child tools differ.
   */
  parent?: Pick<Session, 'agentic_tool' | 'permission_config' | 'model_config'> | null;
  /** Optional branch for MCP server inheritance (branch-level overrides user defaults). */
  branch?: { mcp_server_ids?: string[] | null } | null;
  /**
   * Explicit MCP server ID list. An empty array means "no MCPs" — does NOT
   * fall through to branch/user defaults. Pass `undefined` to fall through.
   */
  mcpServerIds?: string[];
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
}

export interface ResolvedSessionDefaults {
  /** Always populated — falls back to mapped `getDefaultPermissionMode(tool)`. */
  permission_config: NonNullable<Session['permission_config']>;
  /**
   * Always populated for tools with a static default (claude-code, codex,
   * gemini, copilot — falls through overrides → user default → tool
   * default). `undefined` only for cursor, whose default is supplied by its
   * async daemon selector. OpenCode requires a complete exact provider/model
   * pair from an Agor source and throws when none resolves.
   */
  model_config?: NonNullable<Session['model_config']>;
  /** Resolved MCP server list. Empty array means "no MCPs". */
  mcp_server_ids: string[];
}

export function resolveSessionDefaults(args: ResolveSessionDefaultsArgs): ResolvedSessionDefaults {
  const { agenticTool, user, source, parent, branch, mcpServerIds, now } = args;
  const userToolDefaults =
    user?.default_agentic_config?.[agenticTool] ??
    user?.default_agentic_config?.[canonicalTenantAgenticTool(agenticTool)];
  const sameToolParent = parent?.agentic_tool === agenticTool ? parent : undefined;
  const parentLayer = sameToolParent
    ? {
        permissionMode: sameToolParent.permission_config?.mode,
        codexSandboxMode: sameToolParent.permission_config?.codex?.sandboxMode,
        codexApprovalPolicy: sameToolParent.permission_config?.codex?.approvalPolicy,
        codexNetworkAccess: sameToolParent.permission_config?.codex?.networkAccess,
      }
    : undefined;

  const permission_config = resolvePermissionConfig({
    effectiveTool: agenticTool,
    source,
    parentLayer,
    userToolDefaults,
  });

  const model_config = resolveModelConfigWithFallback(
    agenticTool,
    [source?.modelConfig, sameToolParent?.model_config, userToolDefaults?.modelConfig],
    { now }
  );
  if (agenticTool === 'opencode' && !model_config) {
    throw new InvalidModelConfigError(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
  }

  // mcp_server_ids: explicit override wins (incl. empty array = "no MCPs"),
  // then branch config, then user defaults, then [].
  let mcp_server_ids: string[];
  if (mcpServerIds !== undefined) {
    mcp_server_ids = mcpServerIds;
  } else if (branch?.mcp_server_ids && branch.mcp_server_ids.length > 0) {
    mcp_server_ids = branch.mcp_server_ids;
  } else {
    mcp_server_ids = user?.default_mcp_server_ids ?? [];
  }

  return { permission_config, model_config, mcp_server_ids };
}
