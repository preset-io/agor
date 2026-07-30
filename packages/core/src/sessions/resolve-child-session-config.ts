/**
 * Child-session config resolution (fork / spawn / subsession).
 *
 * Sibling of {@link resolveSessionDefaults} — same precedence walk, plus a
 * tool-gated parent layer interposed between explicit overrides and user
 * defaults.
 *
 *   model_config: request → referenced config → parent (same tool only) → user → tool default
 *   permission:   request → referenced config → parent (same tool only) → user → system default
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

import type { AgenticToolModelConfigurationPolicy } from '../models/resolve-config.js';
import {
  type AgenticToolName,
  type DefaultAgenticToolConfig,
  isAgenticToolName,
  type Session,
  type User,
} from '../types/index.js';
import { resolveSessionDefaults } from './resolve-session-defaults.js';

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
  /** The one selected inline or referenced source ahead of the parent fallback. */
  source?: DefaultAgenticToolConfig | null;
  /** Override `new Date()` for deterministic tests. */
  now?: Date;
  modelConfiguration?: AgenticToolModelConfigurationPolicy;
}

export interface ResolvedChildSessionConfig {
  /** Always populated. */
  permission_config: NonNullable<Session['permission_config']>;
  /**
   * Always populated for tools with a static default (claude-code, codex,
   * gemini, copilot). `undefined` only for cursor/opencode whose defaults
   * live in tool-specific selectors. See `resolveModelConfigWithFallback`.
   */
  model_config?: NonNullable<Session['model_config']>;
}

export function resolveChildSessionConfig(
  args: ResolveChildSessionConfigArgs
): ResolvedChildSessionConfig {
  const { parent, user, source, now, modelConfiguration } = args;
  const requestedTool = args.effectiveTool ?? parent.agentic_tool;
  if (!isAgenticToolName(requestedTool)) {
    throw new Error(
      `Cannot resolve child configuration for removed agentic tool: ${requestedTool}`
    );
  }
  const effectiveTool: AgenticToolName = requestedTool;
  const resolved = resolveSessionDefaults({
    agenticTool: effectiveTool,
    user,
    source,
    parent,
    now,
    modelConfiguration,
  });

  return {
    permission_config: resolved.permission_config,
    model_config: resolved.model_config,
  };
}
