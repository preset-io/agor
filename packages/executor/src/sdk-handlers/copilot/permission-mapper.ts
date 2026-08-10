/**
 * Copilot Permission Mapper
 *
 * Maps Agor's permission modes to Copilot SDK's onPermissionRequest callback behavior.
 * Integrates with Agor's PermissionService for interactive permission UI via WebSocket.
 *
 * Copilot SDK uses a callback-based permission model where every tool execution
 * goes through onPermissionRequest, which receives a PermissionRequest with a `kind`:
 * - shell: bash/terminal commands
 * - write: file write operations
 * - read: file read operations
 * - mcp: MCP tool calls
 * - url: URL access
 * - custom-tool: custom tool invocations
 *
 * Returns: 'approved' | 'denied-interactively-by-user' | 'denied-by-rules' | etc.
 */

import { generateId } from '@agor/core';
import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole, PermissionStatus, TaskStatus } from '@agor/core/types';
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
} from '@github/copilot-sdk';
import type {
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
} from '../../db/feathers-repositories.js';
import {
  getPermissionStatus,
  type PermissionService,
} from '../../permissions/permission-service.js';
import { isDaemonOwnedAbort, markInteractionAbort } from '../../termination-state.js';
import type { PermissionMode } from '../../types.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';

/**
 * Re-export SDK types for convenience
 */
export type CopilotPermissionRequest = PermissionRequest;
export type CopilotPermissionDecision = PermissionRequestResult;
export type CopilotPermissionHandler = PermissionHandler;

/**
 * Dependencies for interactive permission handling
 */
export interface PermissionDeps {
  permissionService: PermissionService;
  tasksService: TasksService;
  sessionsRepo: SessionRepository;
  messagesRepo: MessagesRepository;
  messagesService?: MessagesService;
  sessionsService?: SessionsPatchClient;
  mcpServerRepo?: MCPServerRepository;
  sessionMCPRepo?: SessionMCPServerRepository;
  abortController: AbortController;
}

/**
 * Map Copilot permission request kind to a display-friendly tool name
 */
function getToolDisplayName(request: PermissionRequest): string {
  const kind = request.kind;

  // Extract useful details from the request's dynamic properties
  switch (kind) {
    case 'shell':
      return `Shell: ${(request.command as string) || 'command'}`;
    case 'write':
      return `Write: ${(request.path as string) || 'file'}`;
    case 'read':
      return `Read: ${(request.path as string) || 'file'}`;
    case 'mcp': {
      const server = (request.serverName as string) || '';
      const tool = (request.toolName as string) || '';
      return server ? `MCP: ${server}.${tool}` : `MCP: ${tool || 'tool'}`;
    }
    case 'url':
      return `URL: ${(request.url as string) || 'access'}`;
    case 'custom-tool':
      return `Tool: ${(request.toolName as string) || 'custom'}`;
    default:
      return `Permission: ${kind}`;
  }
}

/**
 * Extract tool input details from a Copilot permission request
 */
function getToolInput(request: PermissionRequest): Record<string, unknown> {
  // Copy all dynamic properties except 'kind' and 'toolCallId'
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== 'kind' && key !== 'toolCallId') {
      input[key] = value;
    }
  }
  input.copilot_permission_kind = request.kind;
  return input;
}

/**
 * Determine if a permission kind should be auto-approved based on mode
 *
 * - bypassPermissions / allow-all → approve all
 * - acceptEdits / auto → approve read + write, prompt for shell/mcp/url/custom-tool
 * - default / ask → prompt for everything
 */
function shouldAutoApprove(
  permissionMode: PermissionMode | undefined,
  kind: PermissionRequest['kind']
): boolean {
  // Bypass modes → auto-approve everything
  if (permissionMode === 'bypassPermissions' || permissionMode === 'allow-all') {
    return true;
  }

  // Accept-edits modes → auto-approve reads and writes
  if (permissionMode === 'acceptEdits' || permissionMode === 'auto') {
    return kind === 'read' || kind === 'write';
  }

  // Default / ask → never auto-approve
  return false;
}

/**
 * Check if an MCP permission request is for an attached server (auto-approve)
 */
async function isAttachedMcpServer(
  request: PermissionRequest,
  sessionId: SessionID,
  deps: PermissionDeps
): Promise<boolean> {
  if (request.kind !== 'mcp') return false;

  const serverName = request.serverName as string | undefined;
  if (!serverName) return false;

  // Built-in "agor" server is always auto-approved
  if (serverName === 'agor') return true;

  // Check if server is attached to session via the session-scoped MCP route.
  if (!deps.sessionMCPRepo) return false;

  try {
    const attachedServers = await deps.sessionMCPRepo.listServers(sessionId, true);
    return attachedServers.some((server) => server.name === serverName);
  } catch (error) {
    console.error(`[Copilot Permission] Error verifying MCP server "${serverName}":`, error);
  }

  return false;
}

/**
 * Create a permission handler based on Agor's permission mode
 *
 * When deps are provided, supports interactive permission UI via WebSocket.
 * Without deps, falls back to auto-approve (headless mode).
 *
 * @param sessionId - Agor session ID
 * @param taskId - Current task ID
 * @param permissionMode - Agor permission mode from session config
 * @param deps - Optional dependencies for interactive permission handling
 * @returns Copilot SDK-compatible permission handler callback
 */
export function createPermissionHandler(
  sessionId: SessionID,
  taskId: TaskID,
  permissionMode?: PermissionMode,
  deps?: PermissionDeps
): CopilotPermissionHandler {
  const approved: CopilotPermissionDecision = { kind: 'approved' };

  // bypassPermissions / allow-all → always auto-approve, no deps needed
  if (permissionMode === 'bypassPermissions' || permissionMode === 'allow-all') {
    return async () => approved;
  }

  // No deps → headless fallback (auto-approve everything)
  if (!deps) {
    console.warn(
      `[Copilot Permission] No permission deps provided — auto-approving all (headless mode)`
    );
    return async () => approved;
  }

  // Interactive permission handler
  return async (request: PermissionRequest): Promise<CopilotPermissionDecision> => {
    // Auto-approve based on mode + kind
    if (shouldAutoApprove(permissionMode, request.kind)) {
      console.log(
        `✅ [Copilot Permission] Auto-approved ${request.kind} (mode: ${permissionMode})`
      );
      return approved;
    }

    // Auto-approve MCP tools from attached servers
    if (await isAttachedMcpServer(request, sessionId, deps)) {
      console.log(
        `✅ [Copilot Permission] Auto-approved MCP tool from attached server: ${request.serverName}`
      );
      return approved;
    }

    // --- Interactive permission flow (same pattern as Claude Code) ---

    let releaseInteraction: (() => void) | undefined;

    try {
      releaseInteraction = await deps.permissionService.acquireInteraction(
        sessionId,
        deps.abortController.signal
      );
      const toolName = getToolDisplayName(request);
      console.log(`🔒 [Copilot Permission] Requesting permission for ${toolName}...`);

      // Generate request ID
      const requestId = generateId();
      const timestamp = new Date().toISOString();

      // Get current message index
      const existingMessages = await deps.messagesRepo.findBySessionId(sessionId);
      const nextIndex = existingMessages.length;

      // Create permission request message
      const toolInput = getToolInput(request);
      const permissionMessage: Message = {
        message_id: generateId() as MessageID,
        session_id: sessionId,
        task_id: taskId,
        type: 'permission_request',
        role: MessageRole.SYSTEM,
        index: nextIndex,
        timestamp,
        content_preview: `Permission required: ${toolName}`,
        content: {
          request_id: requestId,
          task_id: taskId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: request.toolCallId,
          status: PermissionStatus.PENDING,
        },
      };

      if (deps.messagesService) {
        await deps.messagesService.create(permissionMessage);
        console.log(`✅ [Copilot Permission] Permission request message created`);
      }

      // Update task status to 'awaiting_permission'
      await deps.tasksService.patch(taskId, {
        status: TaskStatus.AWAITING_PERMISSION,
      });

      // Update session status to 'awaiting_permission'
      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'awaiting_permission' as const,
        });
      }

      // Emit WebSocket event for UI (broadcasts to ALL viewers)
      deps.permissionService.emitRequest(sessionId, {
        requestId,
        taskId,
        toolName,
        toolInput,
        toolUseID: request.toolCallId,
        timestamp,
      });

      // Wait for UI decision (Promise pauses SDK execution)
      const resolution = await deps.permissionService.waitForDecision(
        requestId,
        taskId,
        sessionId,
        deps.abortController.signal
      );

      const permissionStatus = getPermissionStatus(resolution);

      // Update permission request message with outcome
      if (deps.messagesService) {
        const baseContent =
          typeof permissionMessage.content === 'object' && !Array.isArray(permissionMessage.content)
            ? permissionMessage.content
            : {};

        await deps.messagesService.patch(permissionMessage.message_id, {
          content: {
            ...(baseContent as Record<string, unknown>),
            status: permissionStatus,
            scope: resolution.remember ? resolution.scope : undefined,
            approved_by: resolution.decidedBy,
            approved_at: new Date().toISOString(),
          },
        } as Partial<Message>);
      }

      if (isDaemonOwnedAbort(deps.abortController)) {
        return {
          kind: 'denied-interactively-by-user',
          feedback: resolution.reason ?? 'Task termination requested',
        };
      }

      if (resolution.outcome === 'unavailable') {
        const message = resolution.reason ?? `Permission cannot be requested for: ${toolName}`;
        markInteractionAbort(deps.abortController, {
          cause: 'interaction_unavailable',
          errorMessage: message,
        });
        return {
          kind: 'denied-interactively-by-user',
          feedback: message,
        };
      }

      // Abort the Copilot runtime first. The executor finalizer persists the
      // timeout only after the SDK and host cleanup have settled.
      if (resolution.outcome === 'timed_out') {
        const message = `Permission request timed out for: ${toolName}`;
        console.log(`⏰ [Copilot Permission] ${message}`);
        markInteractionAbort(deps.abortController, {
          cause: 'interaction_timeout',
          errorMessage: message,
        });

        return {
          kind: 'denied-interactively-by-user',
          feedback: message,
        };
      }

      // The permission decision settles this tool call, not the conversational turn.
      // Restore active state for both outcomes and leave terminality to the
      // provider's normal task finalization path.
      await deps.tasksService.patch(taskId, {
        status: TaskStatus.RUNNING,
      });

      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'running' as const,
          ready_for_prompt: false,
        });
      }

      // A denial rejects only this tool call. Copilot decides how to continue
      // the turn after receiving the interactive-denial result.
      if (resolution.outcome !== 'approved') {
        console.log(`🛑 [Copilot Permission] Permission denied for ${toolName}; continuing turn`);

        return {
          kind: 'denied-interactively-by-user',
          feedback: resolution.reason || `Permission denied for: ${toolName}`,
        };
      }

      console.log(`✅ [Copilot Permission] Permission approved for ${toolName}`);
      return approved;
    } catch (error) {
      console.error('[Copilot Permission] Error in permission flow:', error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!isDaemonOwnedAbort(deps.abortController)) {
        markInteractionAbort(deps.abortController, {
          cause: 'interaction_unavailable',
          errorMessage,
        });
      }

      return {
        kind: 'denied-interactively-by-user',
        feedback: errorMessage,
      };
    } finally {
      releaseInteraction?.();
    }
  };
}
