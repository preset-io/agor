/**
 * OpenCode SDK handler.
 *
 * Agor orchestration stays here; the OpenCode module owns the complete managed turn.
 */

import { generateId, shortId } from '@agor/core';
import { OPENCODE_MODEL_CONFIG_PAIR_ERROR } from '@agor/core/models';
import type {
  ExecutorPulseKind,
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { PermissionService } from '../../permissions/permission-service.js';
import { createUserMessage } from '../../sdk-handlers/claude/message-builder.js';
import { OpenCodeTool } from '../../sdk-handlers/opencode/index.js';
import type { AgorClient } from '../../services/feathers-client.js';
import { createStreamingCallbacks } from './base-executor.js';

export async function executeOpenCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  dataHome?: string;
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;
  console.log(`[opencode] Executing task ${shortId(taskId)}...`);

  const permissionService = new PermissionService(async (event, data) => {
    if (event === 'permission:request') params.onPulse?.('waiting', 'permission.request');
    if (event === 'permission:timeout') params.onPulse?.('sdk_started', 'permission.timeout');
    client.service('sessions').emit(event, data);
  }, params.resolvedConfig?.execution?.permission_timeout_ms ?? 600_000);
  globalPermissionManager.register(sessionId, permissionService);

  try {
    const session = await client.service('sessions').get(sessionId);
    console.log('[opencode] Session loaded:', {
      sessionId: shortId(sessionId),
      sdk_session_id: session.sdk_session_id ? shortId(session.sdk_session_id) : undefined,
      model: session.model_config?.model,
      provider: session.model_config?.provider,
    });
    if (!session.model_config?.provider?.trim() || !session.model_config.model?.trim()) {
      throw new Error(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }

    const repos = createFeathersBackedRepositories(client);
    const branch = session.branch_id ? await repos.branches.findById(session.branch_id) : null;
    if (!branch?.path) {
      throw new Error('OpenCode requires an Agor branch working directory');
    }

    const messages = await repos.messages.findBySessionId(sessionId);
    await createUserMessage(sessionId, prompt, taskId, messages.length, repos.messagesService, {
      messageSource: params.messageSource,
      existingMessages: messages,
    });

    const assistantMessageId = generateId() as MessageID;
    const tool = new OpenCodeTool({
      sessionMCPRepo: repos.sessionMCP,
      mcpServerRepo: repos.mcpServers,
      mcpOAuthAuthHeadersRepo: repos.mcpOAuthAuthHeaders,
      permissionService,
      messagesRepo: repos.messages,
      messagesService: repos.messagesService,
      tasksService: repos.tasksService,
      sessionsService: repos.sessionsService,
    });
    const result = await tool.runTurn(
      {
        agorSessionId: sessionId,
        taskId,
        prompt,
        agorAssistantMessageId: assistantMessageId,
        existingOpenCodeSessionId: session.sdk_session_id,
        title: session.title || `Task ${shortId(taskId)}`,
        directory: branch.path,
        provider: session.model_config?.provider,
        model: session.model_config?.model,
        mcpToken: session.mcp_token,
        permissionMode: params.permissionMode,
        signal: params.abortController.signal,
        dataHome: params.dataHome,
        persistOpenCodeSessionId: async (openCodeSessionId) => {
          await client.service('sessions').patch(sessionId, {
            sdk_session_id: openCodeSessionId,
          });
        },
      },
      createStreamingCallbacks(client, 'opencode', sessionId, params.onPulse)
    );

    const modelIdentifier =
      session.model_config?.provider && session.model_config?.model
        ? `${session.model_config.provider}/${session.model_config.model}`
        : session.model_config?.model;

    if (!params.abortController.signal.aborted) {
      const finalIndex = (await repos.messages.findBySessionId(sessionId)).length;
      await repos.messagesService.create({
        message_id: assistantMessageId,
        session_id: sessionId,
        task_id: taskId,
        type: 'assistant' as const,
        role: MessageRole.ASSISTANT,
        index: finalIndex,
        timestamp: new Date().toISOString(),
        content_preview: result.finalMessage.content.substring(0, 200),
        content: result.finalMessage.contentBlocks,
        tool_uses:
          result.finalMessage.toolUses.length > 0 ? result.finalMessage.toolUses : undefined,
        metadata: result.finalMessage.metadata,
      });
      await client.service('tasks').patch(taskId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        model: modelIdentifier,
      });
    }
  } catch (error) {
    const err = error as Error;
    console.error('[opencode] Execution failed:', err);
    if (!params.abortController.signal.aborted) {
      await client.service('tasks').patch(taskId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
    }
    throw err;
  } finally {
    globalPermissionManager.unregister(sessionId);
  }
}
