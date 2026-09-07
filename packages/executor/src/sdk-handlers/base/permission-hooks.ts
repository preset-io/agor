/**
 * Permission Hooks for Claude Agent SDK
 *
 * Handles canUseTool callback for custom permission UI via WebSocket.
 * Fires AFTER SDK checks settings.json, respects user's existing permissions.
 * Uses SDK's built-in permission persistence via updatedPermissions.
 */

import { generateId, shortId } from '@agor/core';
import { AGOR_MCP_SERVER_NAME } from '@agor/core/mcp';
import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole, PermissionScope, PermissionStatus, TaskStatus } from '@agor/core/types';
import type {
  MCPServerRepository,
  MessagesRepository,
  SessionMCPServerRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { MessagesService, SessionsPatchClient, TasksService } from './index.js';
import type { McpToolPermissionIndex } from './mcp-tool-permissions.js';
import { mcpToolNameAliasesForServer, resolveMcpToolPermission } from './mcp-tool-permissions.js';

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
    messagesRepo: MessagesRepository;
    messagesService?: MessagesService;
    sessionsService?: SessionsPatchClient;
    permissionLocks: Map<SessionID, Promise<void>>;
    mcpServerRepo: MCPServerRepository;
    sessionMCPRepo: SessionMCPServerRepository;
    /** Per-tool `tool_permissions` from the session's resolved MCP servers. */
    mcpToolPermissions: McpToolPermissionIndex;
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
      // Per-tool `tool_permissions` outrank every fast-path below: a denied tool
      // must never reach the MCP server, and an `ask` tool must never be
      // auto-approved just because its server is attached.
      const configuredPermission = resolveMcpToolPermission(deps.mcpToolPermissions, toolName);

      if (configuredPermission === 'deny') {
        console.warn(`🛑 [canUseTool] MCP tool "${toolName}" denied by tool_permissions`);
        return {
          behavior: 'deny' as const,
          message: `Tool "${toolName}" is denied by its MCP server's tool permissions.`,
        };
      }

      const parts = toolName.split('__');
      if (configuredPermission === 'ask') {
        console.log(
          `❓ [canUseTool] MCP tool "${toolName}" set to "ask" by tool_permissions, prompting user`
        );
        // Fall through to normal permission flow
      } else if (parts.length >= 3) {
        const serverName = parts[1]; // Extract server name from mcp__<server_name>__<tool_name>

        // Built-in "agor" server is always auto-approved (it's added dynamically, not in DB)
        if (serverName === AGOR_MCP_SERVER_NAME) {
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
          const attachedServers = await deps.sessionMCPRepo.listServers(sessionId, true);
          // `serverName` was split out of a tool name the SDK already rewrote,
          // so a raw comparison misses every server whose name carries
          // punctuation or spaces.
          const serverVerified = attachedServers.some((server) =>
            mcpToolNameAliasesForServer(server.name).includes(serverName)
          );

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
          `⏳ [canUseTool] Waiting for pending permission check (session ${shortId(sessionId)})`
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

      // Get the append index without transferring the session transcript.
      const nextIndex = await deps.messagesRepo.getNextIndexBySessionId(sessionId);

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
        console.log(`✅ [canUseTool] Permission request updated: ${permissionStatus}`);
      }

      // Terminalize the Task and deny the tool call. The daemon projects every
      // terminal Task state onto its Session before acknowledging this request.
      // A follow-up executor request would be invalid because the terminal
      // patch revokes this Task's scoped credential.
      if (decision.timedOut) {
        console.log(
          `⏰ [canUseTool] Permission timed out for ${toolName}, setting timed_out state...`
        );

        await deps.tasksService.patch(taskId, {
          status: TaskStatus.TIMED_OUT,
          completed_at: new Date().toISOString(),
        });

        return {
          behavior: 'deny' as const,
          message: `Permission request timed out for tool: ${toolName}. Send a new prompt to retry.`,
        };
      }

      // The permission decision settles this tool call, not the conversational turn.
      // Return the task/session to their active state for both approval and denial;
      // normal provider finalization remains the sole owner of terminal task state.
      await deps.tasksService.patch(taskId, {
        status: TaskStatus.RUNNING,
      });

      if (deps.sessionsService) {
        await deps.sessionsService.patch(sessionId, {
          status: 'running' as const,
          ready_for_prompt: false,
        });
        console.log(
          `✅ [canUseTool] Session ${sessionId} restored to running after permission decision`
        );
      }

      // A denial rejects only this tool call. The SDK can report it to the model,
      // which may continue the turn or choose a different action.
      if (!decision.allow) {
        console.log(`🛑 [canUseTool] Permission denied for ${toolName}; continuing turn`);

        return {
          behavior: 'deny' as const,
          message: `Permission denied for tool: ${toolName}`,
        };
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
        console.log(`🔓 [canUseTool] Released permission lock for session ${shortId(sessionId)}`);
      }
    }
  };
}
