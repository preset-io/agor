/**
 * Copilot Permission Mapper
 *
 * Maps Agor's permission modes to Copilot SDK's onPermissionRequest callback behavior.
 *
 * Copilot SDK uses a callback-based permission model where every tool execution
 * goes through onPermissionRequest, which receives a PermissionRequest with a `kind`:
 * - shell: bash/terminal commands
 * - write: file write operations
 * - read: file read operations
 * - mcp: MCP tool calls
 * - url: URL access
 * - memory: session memory operations
 *
 * Returns: 'approved' | 'denied-interactively-by-user' | 'denied-by-rules'
 */

import type { PermissionMode } from '../../types.js';

/**
 * Copilot SDK permission request structure
 */
export interface CopilotPermissionRequest {
  kind: 'shell' | 'write' | 'read' | 'mcp' | 'url' | 'memory';
  /** Tool name or command being requested */
  tool?: string;
  /** Additional context about the request */
  context?: Record<string, unknown>;
}

/**
 * Copilot SDK permission decision
 */
export type CopilotPermissionDecision =
  | 'approved'
  | 'denied-interactively-by-user'
  | 'denied-by-rules';

/**
 * Permission handler function type (matches Copilot SDK's onPermissionRequest)
 */
export type CopilotPermissionHandler = (
  request: CopilotPermissionRequest
) => Promise<CopilotPermissionDecision>;

/**
 * Create a permission handler based on Agor's permission mode
 *
 * @param permissionMode - Agor permission mode from session config
 * @returns Copilot SDK-compatible permission handler callback
 */
export function createPermissionHandler(
  permissionMode?: PermissionMode
): CopilotPermissionHandler {
  // bypassPermissions / allow-all → auto-approve everything
  if (permissionMode === 'bypassPermissions' || permissionMode === 'allow-all') {
    return async () => 'approved';
  }

  // acceptEdits / auto → auto-approve reads/writes, approve shell/MCP/URL too
  // (In headless/server mode, we can't prompt the user interactively,
  //  so auto mode auto-approves everything like bypassPermissions)
  if (permissionMode === 'acceptEdits' || permissionMode === 'auto') {
    return async (request) => {
      if (request.kind === 'read' || request.kind === 'write') {
        return 'approved';
      }
      // In server/executor context, we auto-approve other operations too
      // since there's no interactive UI to prompt the user during execution.
      // Permission control is handled at the Agor session level before execution.
      return 'approved';
    };
  }

  // default / ask / on-failure / any other → auto-approve in executor context
  // Note: In the executor, we can't interactively prompt the user.
  // Permission decisions are made at the Agor daemon level before spawning the executor.
  // The permission mode here controls the SDK's behavior, but actual enforcement
  // happens via Agor's permission service at the daemon/UI level.
  return async () => 'approved';
}
