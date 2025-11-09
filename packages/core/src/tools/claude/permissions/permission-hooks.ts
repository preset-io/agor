/**
 * Permission Hooks for Claude Agent SDK
 *
 * Handles canUseTool callback for custom permission UI via WebSocket.
 * Fires AFTER SDK checks settings.json, respects user's existing permissions.
 * Uses SDK's built-in permission persistence via updatedPermissions.
 */

import type { MessagesRepository } from '../../../db/repositories/messages';
import { generateId } from '../../../lib/ids';
import type { PermissionService } from '../../../permissions/permission-service';
import type { Message, MessageID, SessionID, TaskID } from '../../../types';
import { MessageRole, PermissionScope, PermissionStatus, TaskStatus } from '../../../types';
import type { MessagesService, SessionsService, TasksService } from '../claude-tool';

/**
 * Create PreToolUse hook for permission handling
 *
 * This hook intercepts tool calls and shows a custom permission UI via WebSocket.
 * Serializes permission checks per session to prevent duplicate prompts.
 */
export function createPreToolUseHook(
  sessionId: SessionID,
  taskId: TaskID,
  deps: {
    permissionService: PermissionService;
    tasksService: TasksService;
    sessionsRepo: SessionRepository;
    reposRepo?: RepoRepository;
    messagesRepo: MessagesRepository;
    messagesService?: MessagesService;
    sessionsService?: SessionsService;
    worktreesRepo?: WorktreeRepository;
    permissionLocks: Map<SessionID, Promise<void>>;
  }
) {
  return async (
    input: PreToolUseHookInput,
    toolUseID: string | undefined,
    options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    // Track lock release function for finally block
    let releaseLock: (() => void) | undefined;

    try {
      // STEP 1: Wait for any pending permission check to finish (queue serialization)
      // This prevents duplicate prompts for concurrent tool calls
      const existingLock = deps.permissionLocks.get(sessionId);
      if (existingLock) {
        console.log(
          `⏳ Waiting for pending permission check to complete (session ${sessionId.substring(0, 8)})`
        );
        await existingLock;
        console.log(`✅ Permission check complete, rechecking DB...`);
      }

      // STEP 2: Check session-specific permission overrides
      // IMPORTANT: Re-fetch after waiting for lock - previous hook may have saved permission
      const session = await deps.sessionsRepo.findById(sessionId);

      if (session?.permission_config?.allowedTools?.includes(input.tool_name)) {
        console.log(`✅ Tool ${input.tool_name} allowed by session config (after queue wait)`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Allowed by session config',
          },
        };
      }

      // STEP 2.5: Check repo-level permission overrides
      // Get the repo for this session via worktree
      if (session?.worktree_id && deps.worktreesRepo && deps.reposRepo) {
        const worktree = await deps.worktreesRepo.findById(session.worktree_id);
        if (worktree?.repo_id) {
          const repo = await deps.reposRepo.findById(worktree.repo_id);
          if (repo?.permission_config?.allowedTools?.includes(input.tool_name)) {
            console.log(`✅ Tool ${input.tool_name} allowed by repo config`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: 'Allowed by repository config',
              },
            };
          }
        }
      }

      // STEP 3: No existing permission - create lock and show prompt
      console.log(
        `🔒 No permission found for ${input.tool_name}, creating lock and prompting user...`
      );
      const newLock = new Promise<void>(resolve => {
        releaseLock = resolve;
      });
      deps.permissionLocks.set(sessionId, newLock);

      // Generate request ID
      const requestId = generateId();
      const timestamp = new Date().toISOString();

      // Execute permission request creation with session guard
      // This checks session exists upfront and handles FK errors gracefully
      const permissionMessage = await withSessionGuard(
        sessionId,
        deps.sessionsRepo,
        async (): Promise<Message | null> => {
          // Get current message index for this session
          const existingMessages = await deps.messagesRepo.findBySessionId(sessionId);
          const nextIndex = existingMessages.length;

          // Create permission request message
          console.log(`🔒 Creating permission request message for ${input.tool_name}`, {
            request_id: requestId,
            task_id: taskId,
            index: nextIndex,
          });

          const message: Message = {
            message_id: generateId() as MessageID,
            session_id: sessionId,
            task_id: taskId,
            type: 'permission_request',
            role: MessageRole.SYSTEM,
            index: nextIndex,
            timestamp,
            content_preview: `Permission required: ${input.tool_name}`,
            content: {
              request_id: requestId,
              tool_name: input.tool_name,
              tool_input: input.tool_input as Record<string, unknown>,
              tool_use_id: toolUseID,
              status: PermissionStatus.PENDING,
            },
          };

          try {
            if (deps.messagesService) {
              await deps.messagesService.create(message);
              console.log(`✅ Permission request message created successfully`);
            }
            return message;
          } catch (createError) {
            // Check if this is a FK constraint error (session was deleted mid-flight)
            if (isForeignKeyConstraintError(createError)) {
              console.warn(`   Session deleted during permission request creation`);
              return null;
            }
            throw createError;
          }
        }
      );

      // If session was deleted, return deny decision gracefully
      if (!permissionMessage) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Session no longer exists',
          },
        };
      }

      // Update task status to 'awaiting_permission'
      try {
        await deps.tasksService.patch(taskId, {
          status: TaskStatus.AWAITING_PERMISSION,
        });
        console.log(`✅ Task ${taskId} updated to awaiting_permission`);
      } catch (patchError) {
        console.error(`❌ CRITICAL: Failed to patch task ${taskId}:`, patchError);
        throw patchError;
      }

      // Update session status to 'awaiting_permission'
      try {
        if (deps.sessionsService) {
          await deps.sessionsService.patch(sessionId, {
            status: 'awaiting_permission' as const,
          });
          console.log(`✅ Session ${sessionId} updated to awaiting_permission`);
        }
      } catch (patchError) {
        console.error(`⚠️  Failed to patch session ${sessionId}:`, patchError);
        // Don't throw - task status is more critical
      }

      // Emit WebSocket event for UI (broadcasts to ALL viewers)
      deps.permissionService.emitRequest(sessionId, {
        requestId,
        taskId,
        toolName: input.tool_name,
        toolInput: input.tool_input as Record<string, unknown>,
        toolUseID,
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
        try {
          const baseContent =
            typeof permissionMessage.content === 'object' &&
            !Array.isArray(permissionMessage.content)
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
            `✅ Permission request message updated: ${decision.allow ? 'approved' : 'denied'}`
          );
        } catch (updateError) {
          console.error(
            `⚠️  Failed to update permission request message (session may have been deleted):`,
            updateError
          );
          // Don't throw - permission decision is what matters, not message update
        }
      }

      // Update task status
      await deps.tasksService.patch(taskId, {
        status: decision.allow ? TaskStatus.RUNNING : TaskStatus.FAILED,
      });

      // If permission was denied, immediately stop the task execution
      if (!decision.allow) {
        console.log(`🛑 Permission denied for ${input.tool_name}, stopping task execution...`);

        // Cancel all pending permission requests for this session
        // (in case there are parallel permission requests queued)
        deps.permissionService.cancelPendingRequests(sessionId);

        // Set session status to idle (execution stopped)
        if (deps.sessionsService) {
          try {
            await deps.sessionsService.patch(sessionId, {
              status: 'idle' as const,
            });
            console.log(`✅ Session ${sessionId} set to idle after permission denial`);
          } catch (patchError) {
            console.warn(
              `⚠️  Failed to update session status to idle (session may have been deleted):`,
              patchError
            );
            // Don't throw - denial is what matters
          }
        }

        // Throw an error to abort SDK execution
        // This will be caught by the prompt service's try-catch and properly cleanup
        throw new Error(`Permission denied for tool: ${input.tool_name}`);
      } else {
        // Restore session status to running (only if approved)
        if (deps.sessionsService) {
          try {
            await deps.sessionsService.patch(sessionId, {
              status: 'running' as const,
            });
            console.log(`✅ Session ${sessionId} restored to running after permission approval`);
          } catch (patchError) {
            console.warn(
              `⚠️  Failed to update session status to running (session may have been deleted):`,
              patchError
            );
            // Don't throw - approval is what matters, continue execution
          }
        }
      }

      // Persist decision if user clicked "Remember"
      if (decision.remember) {
        // RE-FETCH session to get latest data (avoid stale closure)
        const freshSession = await deps.sessionsRepo.findById(sessionId);
        if (!freshSession) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision.allow ? 'allow' : 'deny',
              permissionDecisionReason: decision.reason,
            },
          };
        }

        if (decision.scope === 'session') {
          // Update session-level permissions via FeathersJS service (broadcasts WebSocket events)
          const currentAllowed = freshSession.permission_config?.allowedTools || [];

          // IMPORTANT: Use FeathersJS service (if available) for WebSocket broadcasting
          // Fall back to repository if service not available (e.g., in tests)
          const newAllowedTools = [...currentAllowed, input.tool_name];
          const updateData = {
            permission_config: {
              allowedTools: newAllowedTools,
            },
          };

          if (deps.sessionsService) {
            await deps.sessionsService.patch(sessionId, updateData);
          } else {
            await deps.sessionsRepo.update(sessionId, updateData);
          }
        } else if (decision.scope === 'project') {
          // Update repo-level permissions in database
          // Get repo ID from worktree
          if (freshSession.worktree_id && deps.worktreesRepo && deps.reposRepo) {
            const worktree = await deps.worktreesRepo.findById(freshSession.worktree_id);
            if (worktree?.repo_id) {
              const repo = await deps.reposRepo.findById(worktree.repo_id);
              if (repo) {
                const currentAllowed = repo.permission_config?.allowedTools || [];
                const newAllowedTools = [...currentAllowed, input.tool_name];

                // Update repo with new permission config
                await deps.reposRepo.update(worktree.repo_id, {
                  permission_config: {
                    allowedTools: newAllowedTools,
                  },
                });

                console.log(
                  `✅ Tool ${input.tool_name} added to repo-level permissions (repo: ${worktree.repo_id.substring(0, 8)})`
                );
              }

              // Also update .claude/settings.json for git-tracked permissions (optional)
              await updateProjectSettings(worktree.path, {
                allowTools: [input.tool_name],
              });
            }
          }
        }
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          permissionDecisionReason: decision.reason,
        },
      };
    } catch (error) {
      // On any error in the permission flow, mark task as failed
      console.error('PreToolUse hook error:', error);

      try {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timestamp = new Date().toISOString();

        // Check if this is a permission denial (already marked as failed above)
        const isPermissionDenial =
          error instanceof Error && error.message.startsWith('Permission denied for tool:');

        if (!isPermissionDenial) {
          // Only update task status if not already marked as failed by permission denial
          await deps.tasksService.patch(taskId, {
            status: TaskStatus.FAILED,
            report: `Error: ${errorMessage}\nTimestamp: ${timestamp}`,
          });
        }
      } catch (updateError) {
        console.error('Failed to update task status:', updateError);
      }

      // Re-throw error to abort SDK execution
      // This ensures the SDK stops processing and doesn't continue with other operations
      throw error;
    } finally {
      // STEP 4: Always release the lock when done (success or error)
      // This allows queued hooks to proceed
      if (releaseLock) {
        releaseLock();
        deps.permissionLocks.delete(sessionId);
        console.log(`🔓 Released permission lock for session ${sessionId.substring(0, 8)}`);
      }
    }
  };
}

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
    sessionsRepo: import('../../../db/repositories/sessions').SessionRepository;
    messagesRepo: MessagesRepository;
    messagesService?: MessagesService;
    sessionsService?: SessionsService;
    permissionLocks: Map<SessionID, Promise<void>>;
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
      const newLock = new Promise<void>(resolve => {
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
        console.log(`🔓 [canUseTool] Released permission lock for session ${sessionId.substring(0, 8)}`);
      }
    }
  };
}
