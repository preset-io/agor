/**
 * Permission Hooks for Claude Agent SDK
 *
 * Handles canUseTool callback for custom permission UI via WebSocket.
 * Fires AFTER SDK checks settings.json, respects user's existing permissions.
 * Uses SDK's built-in permission persistence via updatedPermissions.
 */

import { generateId } from '@agor/core';
import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole, PermissionScope, PermissionStatus, TaskStatus } from '@agor/core/types';
import type {
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
  SessionRepository,
} from '../../../db/feathers-repositories.js';
import type { PermissionService } from '../../../permissions/permission-service.js';
import type { MessagesService, SessionsService, TasksService } from '../claude-tool.js';

/**
 * Create canUseTool callback for permission handling
 *
 * This callback is invoked by the SDK when it would show a permission prompt
 * (i.e., after checking settings.json and permission mode, but no rule matched).
 * Shows Agor's custom permission UI via WebSocket and uses SDK's built-in permission persistence.
 */
export function createCanUseToolCallback(
  sessionId: SessionID,
  taskId: TaskID,
  deps: {
    permissionService: PermissionService;
    tasksService: TasksService;
    sessionsRepo: SessionRepository;
    messagesRepo: MessagesRepository;
    messagesService?: MessagesService;
    sessionsService?: SessionsService;
    permissionLocks: Map<SessionID, Promise<void>>;
    mcpServerRepo: MCPServerRepository;
    sessionMCPRepo: SessionMCPServerRepository;
  }
) {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: Array<Record<string, unknown>> }
  ): Promise<{
    behavior: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: Array<{
      type: 'addRules';
      rules: Array<{ toolName: string }>;
      behavior: 'allow';
      destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
    }>;
    message?: string;
  }> => {
    // Auto-approve MCP tools only if they belong to an attached MCP server
    // MCP tool names follow pattern: mcp__<server_name>__<tool_name>
    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      if (parts.length >= 3) {
        const serverName = parts[1]; // Extract server name from mcp__<server_name>__<tool_name>

        // Built-in "agor" server is always auto-approved (it's added dynamically, not in DB)
        if (serverName === 'agor') {
          console.log(
            `✅ [canUseTool] Auto-approving MCP tool: ${toolName} (built-in "agor" server)`
          );
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          };
        }

        try {
          // Get the session's attached MCP servers
          const sessionMCPs = await deps.sessionMCPRepo.findBySessionId(sessionId);
          const attachedServerIds = sessionMCPs.map((s) => s.mcp_server_id);

          // Look up the MCP servers to check their names
          let serverVerified = false;
          for (const serverId of attachedServerIds) {
            const server = await deps.mcpServerRepo.findById(serverId);
            if (server && server.name === serverName) {
              serverVerified = true;
              break;
            }
          }

          if (serverVerified) {
            console.log(
              `✅ [canUseTool] Auto-approving MCP tool: ${toolName} (server "${serverName}" is attached)`
            );
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              updatedPermissions: [
                {
                  type: 'addRules',
                  rules: [{ toolName }],
                  behavior: 'allow',
                  destination: 'session',
                },
              ],
            };
          }

          console.warn(
            `⚠️ [canUseTool] MCP tool "${toolName}" rejected: server "${serverName}" not attached to session`
          );
          // Fall through to normal permission flow
        } catch (error) {
          console.error(`[canUseTool] Error verifying MCP server for tool ${toolName}:`, error);
          // Fall through to normal permission flow on error
        }
      } else {
        console.warn(
          `⚠️ [canUseTool] MCP tool "${toolName}" has invalid format, requiring manual approval`
        );
        // Fall through to normal permission flow for malformed tool names
      }
    }

    // This callback fires AFTER SDK checks settings.json
    // We show Agor's UI and let SDK handle persistence via updatedPermissions

    // Track lock release function for finally block
    let releaseLock: (() => void) | undefined;

    try {
      // STEP 1: Wait for any pending permission check to finish (queue serialization)
      const existingLock = deps.permissionLocks.get(sessionId);
      if (existingLock) {
        console.log(
          `⏳ [canUseTool] Waiting for pending permission check (session ${sessionId.substring(0, 8)})`
        );
        await existingLock;
        console.log(`✅ [canUseTool] Permission check complete, proceeding...`);
      }

      // STEP 2: Create lock for this permission check
      console.log(`🔒 [canUseTool] Requesting permission for ${toolName}...`);
      const newLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      deps.permissionLocks.set(sessionId, newLock);

      // Generate request ID
      const requestId = generateId();
      const timestamp = new Date().toISOString();

      // Get current message index for this session
      const existingMessages = await deps.messagesRepo.findBySessionId(sessionId);
      const nextIndex = existingMessages.length;

      // Create permission request message
      console.log(`🔒 [canUseTool] Creating permission request message for ${toolName}`, {
        request_id: requestId,
        task_id: taskId,
        index: nextIndex,
      });

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
          task_id: taskId, // Required for daemon to route permission_resolved event back to executor
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: undefined,
          status: PermissionStatus.PENDING,
        },
      };

      if (deps.messagesService) {
        await deps.messagesService.create(permissionMessage);
        console.log(`✅ [canUseTool] Permission request message created`);
      }

      // Update task status to 'awaiting_permission'
      await deps.tasksService.patch(taskId, {
        status: TaskStatus.AWAITING_PERMISSION,
      });
      console.log(`✅ [canUseTool] Task ${taskId} updated to awaiting_permission`);

      // Update session status to 'awaiting_permission'
      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'awaiting_permission' as const,
        });
        console.log(`✅ [canUseTool] Session ${sessionId} updated to awaiting_permission`);
      }

      // Emit WebSocket event for UI (broadcasts to ALL viewers)
      deps.permissionService.emitRequest(sessionId, {
        requestId,
        taskId,
        toolName,
        toolInput,
        toolUseID: undefined,
        timestamp,
      });

      // Wait for UI decision (Promise pauses SDK execution)
      const decision = await deps.permissionService.waitForDecision(
        requestId,
        taskId,
        sessionId,
        options.signal
      );

      // Update permission request message with approval/denial
      if (deps.messagesService) {
        const baseContent =
          typeof permissionMessage.content === 'object' && !Array.isArray(permissionMessage.content)
            ? permissionMessage.content
            : {};
        // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service has patch method but type definition is incomplete
        await (deps.messagesService as any).patch(permissionMessage.message_id, {
          content: {
            ...(baseContent as Record<string, unknown>),
            status: decision.allow ? PermissionStatus.APPROVED : PermissionStatus.DENIED,
            scope: decision.remember ? decision.scope : undefined,
            approved_by: decision.decidedBy,
            approved_at: new Date().toISOString(),
          },
        });
        console.log(
          `✅ [canUseTool] Permission request updated: ${decision.allow ? 'approved' : 'denied'}`
        );
      }

      // Update task status
      await deps.tasksService.patch(taskId, {
        status: decision.allow ? TaskStatus.RUNNING : TaskStatus.FAILED,
      });

      // If permission was denied, stop execution
      if (!decision.allow) {
        console.log(`🛑 [canUseTool] Permission denied for ${toolName}, stopping execution...`);

        // Cancel all pending permission requests for this session
        deps.permissionService.cancelPendingRequests(sessionId);

        // Set session status to idle
        if (deps.sessionsService) {
          await deps.sessionsService.patch(sessionId, {
            status: 'idle' as const,
          });
          console.log(`✅ [canUseTool] Session ${sessionId} set to idle after denial`);
        }

        return {
          behavior: 'deny' as const,
          message: `Permission denied for tool: ${toolName}`,
        };
      }

      // Restore session status to running (only if approved)
      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'running' as const,
        });
        console.log(`✅ [canUseTool] Session ${sessionId} restored to running after approval`);
      }

      // Build response with SDK's updatedPermissions for persistence
      const response: {
        behavior: 'allow';
        updatedInput: Record<string, unknown>;
        updatedPermissions?: Array<{
          type: 'addRules';
          rules: Array<{ toolName: string }>;
          behavior: 'allow';
          destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
        }>;
      } = {
        behavior: 'allow' as const,
        updatedInput: toolInput,
      };

      // Add updatedPermissions based on user's scope choice
      if (decision.remember && decision.scope) {
        // Map Agor's scopes to SDK destinations
        let destination: 'projectSettings' | 'userSettings' | 'localSettings';

        switch (decision.scope) {
          case PermissionScope.PROJECT:
            destination = 'projectSettings';
            break;
          case PermissionScope.USER:
            destination = 'userSettings';
            break;
          case PermissionScope.LOCAL:
            destination = 'localSettings';
            break;
          default:
            // Don't add updatedPermissions for 'once' scope
            return response;
        }

        response.updatedPermissions = [
          {
            type: 'addRules',
            rules: [{ toolName }],
            behavior: 'allow',
            destination,
          },
        ];
      }

      return response;
    } catch (error) {
      console.error('[canUseTool] Error in permission flow:', error);

      try {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timestamp = new Date().toISOString();

        // Update task status to failed
        await deps.tasksService.patch(taskId, {
          status: TaskStatus.FAILED,
          report: `Error: ${errorMessage}\nTimestamp: ${timestamp}`,
        });
      } catch (updateError) {
        console.error('[canUseTool] Failed to update task status:', updateError);
      }

      return {
        behavior: 'deny' as const,
        message: error instanceof Error ? error.message : 'Unknown error in permission flow',
      };
    } finally {
      // STEP 3: Always release the lock when done (success or error)
      if (releaseLock) {
        releaseLock();
        deps.permissionLocks.delete(sessionId);
        console.log(
          `🔓 [canUseTool] Released permission lock for session ${sessionId.substring(0, 8)}`
        );
      }
    }
  };
}
