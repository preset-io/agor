/**
 * Session creation config resolution (no parent — fresh sessions).
 *
 * Single source of truth for "given a user (and optional overrides), what
 * permission_config / model_config / mcp_server_ids should this new session
 * be stamped with?" Used by:
 * - `apps/agor-daemon/src/mcp/tools/sessions.ts`   (`agor_sessions_create`)
 * - `apps/agor-daemon/src/services/zone-trigger.ts` (`fireAlwaysNewZoneTrigger`)
 * - `apps/agor-daemon/src/services/gateway.ts`     (gateway session creation)
 * - `apps/agor-daemon/src/utils/apply-session-config-defaults.ts` (the
 *   `before:create` hook for any UI/REST caller that omits config)
 *
 * Resolution order:
 *   permission_config: overrides → user default → mapped system default
 *                      (algorithm shared with the child resolver via
 *                      {@link resolvePermissionConfig})
 *   model_config:      overrides → user default → tool default (always
 *                      populated for tools with a static default; only
 *                      `undefined` for cursor/opencode whose defaults
 *                      live elsewhere)
 *   mcp_server_ids:    overrides → branch → user default → []
 *
 * The child-session variant ({@link resolveChildSessionConfig}) layers a
 * tool-gated parent source between overrides and user defaults; both
 * resolvers share the same permission/model walk.
 */

import { resolveModelConfigWithFallback } from '../models/resolve-config.js';
import type { AgenticToolName, Session, User } from '../types/index.js';
import {
  resolvePermissionConfig,
  type SessionRuntimeOverrides,
} from './resolve-permission-config.js';

/** Explicit per-call overrides. Each field, when defined, wins over user defaults. */
export interface SessionDefaultsOverrides extends SessionRuntimeOverrides {
  /**
   * Explicit MCP server ID list. An empty array means "no MCPs" — does NOT
   * fall through to branch/user defaults. Pass `undefined` to fall through.
   */
  mcpServerIds?: string[];
}

export interface ResolveSessionDefaultsArgs {
  agenticTool: AgenticToolName;
  /** User whose agentic and MCP defaults provide the next-priority defaults. */
  user?: Pick<User, 'default_agentic_config' | 'default_mcp_server_ids'> | null;
  /** Optional branch for MCP server inheritance (branch-level overrides user defaults). */
  branch?: { mcp_server_ids?: string[] | null } | null;
  overrides?: SessionDefaultsOverrides;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
}

export interface ResolvedSessionDefaults {
  /** Always populated — falls back to mapped `getDefaultPermissionMode(tool)`. */
  permission_config: NonNullable<Session['permission_config']>;
  /**
   * Always populated for tools with a static default (claude-code, codex,
   * gemini, copilot — falls through overrides → user default → tool
   * default). `undefined` only for cursor/opencode, whose defaults are
   * supplied by their own selectors (cursor: async daemon fetch; opencode:
   * provider + model pair).
   */
  model_config?: NonNullable<Session['model_config']>;
  /** Resolved MCP server list. Empty array means "no MCPs". */
  mcp_server_ids: string[];
}

export function resolveSessionDefaults(args: ResolveSessionDefaultsArgs): ResolvedSessionDefaults {
  const { agenticTool, user, branch, overrides, now } = args;
  const userToolDefaults = user?.default_agentic_config?.[agenticTool];

  const permission_config = resolvePermissionConfig({
    effectiveTool: agenticTool,
    overrides,
    userToolDefaults,
    // No parent layer for fresh-session defaults.
  });

  const model_config = resolveModelConfigWithFallback(
    agenticTool,
    [overrides?.modelConfig, userToolDefaults?.modelConfig],
    { now }
  );

  // mcp_server_ids: explicit override wins (incl. empty array = "no MCPs"),
  // then branch config, then user defaults, then [].
  let mcp_server_ids: string[];
  if (overrides?.mcpServerIds !== undefined) {
    mcp_server_ids = overrides.mcpServerIds;
  } else if (branch?.mcp_server_ids && branch.mcp_server_ids.length > 0) {
    mcp_server_ids = branch.mcp_server_ids;
  } else {
    mcp_server_ids = user?.default_mcp_server_ids ?? [];
  }

  return { permission_config, model_config, mcp_server_ids };
}
