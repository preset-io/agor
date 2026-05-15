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
import { MessageRole, PermissionStatus, SessionStatus, TaskStatus } from '@agor/core/types';
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
import type { PermissionService } from '../../permissions/permission-service.js';
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
  permissionLocks: Map<SessionID, Promise<void>>;
  mcpServerRepo?: MCPServerRepository;
  sessionMCPRepo?: SessionMCPServerRepository;
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

  // Check if server is attached to session
  if (!deps.sessionMCPRepo || !deps.mcpServerRepo) return false;

  try {
    const sessionMCPs = await deps.sessionMCPRepo.findBySessionId(sessionId);
    const attachedServerIds = sessionMCPs.map((s) => s.mcp_server_id);

    for (const serverId of attachedServerIds) {
      const server = await deps.mcpServerRepo.findById(serverId);
      if (server && server.name === serverName) {
        return true;
      }
    }
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

    // Track lock release function for finally block
    let releaseLock: (() => void) | undefined;

    try {
      // STEP 1: Wait for any pending permission check to finish (queue serialization)
      const existingLock = deps.permissionLocks.get(sessionId);
      if (existingLock) {
        console.log(
          `⏳ [Copilot Permission] Waiting for pending permission check (session ${sessionId.substring(0, 8)})`
        );
        await existingLock;
      }

      // STEP 2: Create lock for this permission check
      const toolName = getToolDisplayName(request);
      console.log(`🔒 [Copilot Permission] Requesting permission for ${toolName}...`);
      const newLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      deps.permissionLocks.set(sessionId, newLock);

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
      // Create a minimal AbortSignal — Copilot SDK doesn't pass one to onPermissionRequest
      const abortController = new AbortController();
      const decision = await deps.permissionService.waitForDecision(
        requestId,
        taskId,
        sessionId,
        abortController.signal
      );

      // Determine the resulting permission status
      const permissionStatus = decision.timedOut
        ? PermissionStatus.TIMED_OUT
        : decision.allow
          ? PermissionStatus.APPROVED
          : PermissionStatus.DENIED;

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
            scope: decision.remember ? decision.scope : undefined,
            approved_by: decision.decidedBy,
            approved_at: new Date().toISOString(),
          },
        } as Partial<Message>);
      }

      // Handle timeout
      if (decision.timedOut) {
        console.log(
          `⏰ [Copilot Permission] Permission timed out for ${toolName}, setting timed_out state...`
        );

        await deps.tasksService.patch(taskId, {
          status: TaskStatus.TIMED_OUT,
          completed_at: new Date().toISOString(),
        });

        if (deps.sessionsService) {
          await deps.sessionsService.patch(sessionId, {
            status: SessionStatus.TIMED_OUT,
            ready_for_prompt: true,
          });
        }

        return {
          kind: 'denied-interactively-by-user',
          feedback: `Permission request timed out for: ${toolName}`,
        };
      }

      // Handle denial
      if (!decision.allow) {
        console.log(
          `🛑 [Copilot Permission] Permission denied for ${toolName}, stopping execution...`
        );

        // Cancel all pending permission requests for this session
        deps.permissionService.cancelPendingRequests(sessionId);

        await deps.tasksService.patch(taskId, {
          status: TaskStatus.FAILED,
        });

        if (deps.sessionsService) {
          await deps.sessionsService.patch(sessionId, {
            status: 'idle' as const,
          });
        }

        return {
          kind: 'denied-interactively-by-user',
          feedback: decision.reason || `Permission denied for: ${toolName}`,
        };
      }

      // Approved — restore running status
      await deps.tasksService.patch(taskId, {
        status: TaskStatus.RUNNING,
      });

      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'running' as const,
        });
      }

      console.log(`✅ [Copilot Permission] Permission approved for ${toolName}`);
      return approved;
    } catch (error) {
      console.error('[Copilot Permission] Error in permission flow:', error);

      try {
        await deps.tasksService.patch(taskId, {
          status: TaskStatus.FAILED,
          report: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch (updateError) {
        console.error('[Copilot Permission] Failed to update task status:', updateError);
      }

      return {
        kind: 'denied-interactively-by-user',
        feedback: error instanceof Error ? error.message : 'Unknown error in permission flow',
      };
    } finally {
      // STEP 3: Always release the lock when done
      if (releaseLock) {
        releaseLock();
        deps.permissionLocks.delete(sessionId);
        console.log(
          `🔓 [Copilot Permission] Released permission lock for session ${sessionId.substring(0, 8)}`
        );
      }
    }
  };
}
