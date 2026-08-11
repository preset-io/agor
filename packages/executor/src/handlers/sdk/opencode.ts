/**
 * Thin OpenCode SDK adapter.
 *
 * Agor orchestration stays here; the OpenCode package owns the complete managed turn.
 * Task settlement remains OpenCode-scoped until the generic runner migration lands.
 */

import {
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  parseOpenCodeExecutorContext,
} from '@agor/agentic-tool-opencode';
import {
  isOpenCodeCleanupUnverifiedError,
  OpenCodeTool,
} from '@agor/agentic-tool-opencode/runtime';
import { generateId, shortId } from '@agor/core';
import { resolveSdkWatchdogConfig } from '@agor/core/config';
import { getMcpServersForSession } from '@agor/core/mcp';
import type {
  ExecutorPulseKind,
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { getDaemonUrl } from '../../config.js';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { createExecutionPermissionService } from '../../permissions/permission-service.js';
import { enrichContentBlocks } from '../../sdk-handlers/base/diff-enrichment.js';
import { EMPTY_MCP_TOOL_PERMISSION_INDEX } from '../../sdk-handlers/base/mcp-tool-permissions.js';
import { createCanUseToolCallback } from '../../sdk-handlers/base/permission-hooks.js';
import {
  collectWithheldMcpServers,
  reportWithheldMcpServers,
} from '../../sdk-handlers/base/withheld-mcp-report.js';
import { createUserMessage } from '../../sdk-handlers/claude/message-builder.js';
import type { SdkActivityCallback } from '../../sdk-watchdog.js';
import type { AgorClient } from '../../services/feathers-client.js';
import type { AgenticToolOutcome } from '../../terminal-task.js';
import { isDaemonOwnedAbort } from '../../termination-state.js';
import {
  appendTaskFailureMessage,
  createStreamingCallbacks,
  type FlushableStreamingCallbacks,
  flushStreamingCallbacks,
} from './base-executor.js';

function reportOpenCodePulse(
  callback: SdkActivityCallback | undefined,
  kind: ExecutorPulseKind,
  detail?: string
): void {
  if (kind === 'waiting') return; // PermissionService reports the bounded wait with its real ID.
  if (kind === 'progress') callback?.({ type: 'progress', ...(detail ? { detail } : {}) });
  if (kind === 'sdk_started') callback?.({ type: 'sdk_started', ...(detail ? { detail } : {}) });
  if (kind === 'unknown_activity') {
    callback?.({ type: 'unknown_activity', detail: detail ?? 'unknown.event' });
  }
}

export async function executeOpenCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  agenticToolContext?: Record<string, unknown>;
  resolvedConfig?: ResolvedConfigSlice;
  onActivity?: SdkActivityCallback;
}): Promise<AgenticToolOutcome | undefined> {
  const { client, sessionId, taskId, prompt } = params;
  let callbacks: FlushableStreamingCallbacks | undefined;
  const runtimeCleanupTimeoutMs = resolveSdkWatchdogConfig(
    params.resolvedConfig?.execution
  ).abort_grace_ms;
  console.log(`[opencode] Executing task ${shortId(taskId)}...`);

  const permissionService = createExecutionPermissionService(params);
  globalPermissionManager.register(sessionId, permissionService);

  try {
    const session = await client.service('sessions').get(sessionId);
    if (!session.model_config?.provider?.trim() || !session.model_config.model?.trim()) {
      throw new Error(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
    const { dataHome } = parseOpenCodeExecutorContext(params.agenticToolContext);

    const repos = createFeathersBackedRepositories(client);
    const branch = session.branch_id ? await repos.branches.findById(session.branch_id) : null;
    if (!branch?.path) throw new Error('OpenCode requires an Agor branch working directory');

    callbacks = createStreamingCallbacks(client, 'opencode', sessionId, params.onActivity);

    const messages = await repos.messages.findBySessionId(sessionId);
    await createUserMessage(sessionId, prompt, taskId, messages.length, repos.messagesService, {
      messageSource: params.messageSource,
      existingMessages: messages,
    });

    const assistantMessageId = generateId() as MessageID;
    const tool = new OpenCodeTool({
      resolveMcpServers: async (targetSessionId) => {
        const reporter = collectWithheldMcpServers();
        const servers = await getMcpServersForSession(
          targetSessionId,
          {
            sessionMCPRepo: repos.sessionMCP,
            mcpServerRepo: repos.mcpServers,
            mcpOAuthAuthHeadersRepo: repos.mcpOAuthAuthHeaders,
            forUserId: session.created_by,
            onServerWithheld: reporter.onServerWithheld,
          },
          // OpenCode's invocation config carries no per-tool filter, so a server
          // with gated tools cannot be honoured and is withheld whole. This is
          // the only enforcement point on this path.
          { toolFiltering: 'none' }
        );
        await reportWithheldMcpServers(repos.messages, {
          sessionId: targetSessionId,
          taskId,
          withheld: reporter.withheld,
        });
        return servers;
      },
      getDaemonUrl,
      createPermissionCallback: (targetSessionId, targetTaskId) =>
        createCanUseToolCallback(targetSessionId, targetTaskId, {
          permissionService,
          tasksService: repos.tasksService,
          messagesRepo: repos.messages,
          messagesService: repos.messagesService,
          sessionsService: repos.sessionsService,
          mcpServerRepo: repos.mcpServers,
          sessionMCPRepo: repos.sessionMCP,
          // Gated servers never reach this handler, so nothing here can be
          // configured; the admission gate above already withheld them.
          mcpToolPermissions: EMPTY_MCP_TOOL_PERMISSION_INDEX,
          abortController: params.abortController,
        }),
      cancelPendingPermissions: (targetSessionId) =>
        permissionService.cancelPendingRequests(targetSessionId),
      enrichContentBlocks: (blocks) =>
        enrichContentBlocks(blocks, {
          workingDirectory: branch.path,
          snapshotScope: `${sessionId}:${taskId}`,
        }),
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
        provider: session.model_config.provider,
        model: session.model_config.model,
        effort: session.model_config.effort,
        mcpToken: session.mcp_token,
        permissionMode: params.permissionMode,
        signal: params.abortController.signal,
        dataHome,
        persistOpenCodeSessionId: async (openCodeSessionId) => {
          await client.service('sessions').patch(sessionId, { sdk_session_id: openCodeSessionId });
        },
      },
      {
        ...callbacks,
        onPulse: (kind, detail) => reportOpenCodePulse(params.onActivity, kind, detail),
      }
    );

    if (isDaemonOwnedAbort(params.abortController)) return;
    if (params.abortController.signal.aborted) {
      return { result: 'failure', failureCause: 'runtime_cancelled' };
    }

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
      tool_uses: result.finalMessage.toolUses.length > 0 ? result.finalMessage.toolUses : undefined,
      metadata: result.finalMessage.metadata,
    });
    return {
      result: 'success',
      taskPatch: {
        model: `${session.model_config.provider}/${session.model_config.model}`,
      },
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('[opencode] execution failed category=task_execution');

    if (isOpenCodeCleanupUnverifiedError(failure)) {
      // Keep the task active. Executor exit hands containment to the daemon;
      // making it terminal here would release the session before absence is proven.
      return;
    }
    if (isDaemonOwnedAbort(params.abortController)) return;
    if (params.abortController.signal.aborted) {
      return { result: 'failure', failureCause: 'runtime_cancelled' };
    }
    await appendTaskFailureMessage(client, sessionId, taskId, failure);
    return {
      result: 'failure',
      failureCause: 'runtime_failure',
      taskPatch: { error_message: failure.message },
      error: failure,
    };
  } finally {
    globalPermissionManager.unregister(sessionId);
    await flushStreamingCallbacks(callbacks, runtimeCleanupTimeoutMs, 'opencode');
  }
}
