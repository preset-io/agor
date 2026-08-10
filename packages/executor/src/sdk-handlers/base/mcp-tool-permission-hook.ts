/**
 * PreToolUse gate for MCP `tool_permissions`.
 *
 * `canUseTool` alone is not enough to hold an "ask": the SDK matches
 * settings.json permission rules FIRST and only calls `canUseTool` when no rule
 * decided the call. Agor writes those rules itself — a "remember for project"
 * approval persists `allow` for that exact tool — so a tool later switched to
 * `ask` would keep sailing through on the stale rule without ever prompting.
 *
 * PreToolUse runs ahead of rule matching, so a decision here outranks any
 * settings.json entry. `ask` hands back to `canUseTool`, which runs Agor's
 * existing permission-request flow.
 */

import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import type { McpToolPermissionIndex } from './mcp-tool-permissions.js';
import { resolveMcpToolPermission } from './mcp-tool-permissions.js';

type HookCallback = ClaudeSdk.HookCallback;
type HookJSONOutput = ClaudeSdk.HookJSONOutput;

const PROCEED: HookJSONOutput = { continue: true };

export function createMcpToolPermissionHook(
  mcpToolPermissions: McpToolPermissionIndex,
  /** Whether a live approval channel exists; without one, `ask` cannot be answered. */
  canPromptForPermission: boolean
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return PROCEED;

    const toolName = input.tool_name;
    if (!toolName.startsWith('mcp__')) return PROCEED;

    const permission = resolveMcpToolPermission(mcpToolPermissions, toolName);
    if (permission === 'deny' || (permission === 'ask' && !canPromptForPermission)) {
      console.warn(`🛑 [PreToolUse] MCP tool "${toolName}" blocked by tool_permissions`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Tool "${toolName}" is denied by its MCP server's tool permissions.`,
        },
      };
    }

    if (permission === 'ask') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Tool "${toolName}" requires approval per its MCP server's tool permissions.`,
        },
      };
    }

    return PROCEED;
  };
}
