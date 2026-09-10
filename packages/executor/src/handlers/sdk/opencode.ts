/**
 * Thin OpenCode SDK adapter.
 *
 * Agor orchestration stays here; the OpenCode package owns the complete managed turn.
 * Task settlement remains OpenCode-scoped until the generic runner migration lands.
 */

import {
  buildOpenCodeAuthContent,
  isOpenCodeManagedExecutorContext,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  parseOpenCodeExecutorContext,
} from '@agor/agentic-tool-opencode';
import {
  discardOpenCodeScratch,
  isOpenCodeCleanupUnverifiedError,
  OpenCodeTool,
  prepareOpenCodeScratch,
  pruneOpenCodeAttempts,
  resolveOpenCodeNativeStateLayout,
  restoreOpenCodeAcceptedState,
} from '@agor/agentic-tool-opencode/runtime';
import { generateId, shortId } from '@agor/core';
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
import { PermissionService } from '../../permissions/permission-service.js';
import { resolveContextUserId } from '../../sdk-handlers/base/context-user.js';
import { enrichContentBlocks } from '../../sdk-handlers/base/diff-enrichment.js';
import { EMPTY_MCP_TOOL_PERMISSION_INDEX } from '../../sdk-handlers/base/mcp-tool-permissions.js';
import { createCanUseToolCallback } from '../../sdk-handlers/base/permission-hooks.js';
import {
  collectWithheldMcpServers,
  reportWithheldMcpServers,
} from '../../sdk-handlers/base/withheld-mcp-report.js';
import { createUserMessage } from '../../sdk-handlers/claude/message-builder.js';
import type { AgorClient } from '../../services/feathers-client.js';
import {
  createStreamingCallbacks,
  MissingCredentialError,
  resolveApiKeyForTask,
  settleTaskFailure,
} from './base-executor.js';

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
  let managedScratch: Parameters<typeof discardOpenCodeScratch>[0] | undefined;

  try {
    const session = await client.service('sessions').get(sessionId);
    if (!session.model_config?.provider?.trim() || !session.model_config.model?.trim()) {
      throw new Error(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
    const context = parseOpenCodeExecutorContext(params.agenticToolContext);
    const managedContext = isOpenCodeManagedExecutorContext(context) ? context : undefined;
    const dataHome = isOpenCodeManagedExecutorContext(context) ? undefined : context.dataHome;
    if (managedContext && managedContext.taskId !== taskId) {
      throw new Error('OpenCode managed executor context does not belong to this task');
    }

    const repos = createFeathersBackedRepositories(client);
    const contextUserId = await resolveContextUserId({
      session,
      taskId,
      tasksService: repos.tasksService,
    });
    const branch = session.branch_id ? await repos.branches.findById(session.branch_id) : null;
    if (!branch?.path) throw new Error('OpenCode requires an Agor branch working directory');

    const [messages, sessionNextIndex] = await Promise.all([
      repos.messages.findInitialUserMessagesByTaskId(taskId),
      repos.messages.getNextIndexBySessionId(sessionId),
    ]);
    await createUserMessage(sessionId, prompt, taskId, sessionNextIndex, repos.messagesService, {
      messageSource: params.messageSource,
      existingMessages: messages,
    });

    // Hosted managed projection: pull the owner's reviewed provider keys
    // through the task-scoped daemon read (never the payload), prepare the
    // Job-local scratch, prune stale attempts, and restore the accepted
    // checkpoint. Credentials stay in memory; nothing enters process.env.
    let managed: NonNullable<Parameters<OpenCodeTool['runTurn']>[0]['managed']> | undefined;
    if (managedContext) {
      const resolution = await resolveApiKeyForTask(
        'OPENCODE_API_KEY_ANTHROPIC',
        client,
        taskId,
        'opencode'
      );
      if (resolution.decryptionFailed) {
        throw new Error(
          'A saved OpenCode provider key could not be decrypted. Re-enter it in Settings > OpenCode.'
        );
      }
      const projected = buildOpenCodeAuthContent(resolution.connection ?? {});
      if (!projected.content) {
        throw new MissingCredentialError(
          'No OpenCode provider key is saved for this session owner. Save one in Settings > OpenCode.'
        );
      }
      const nativeState = resolveOpenCodeNativeStateLayout({
        namespaceKey: managedContext.namespaceKey,
        agorSessionId: managedContext.agorSessionId,
        taskId,
      });
      await prepareOpenCodeScratch(nativeState);
      managedScratch = nativeState;
      await pruneOpenCodeAttempts(nativeState, managedContext.accepted);
      if (managedContext.accepted) {
        await restoreOpenCodeAcceptedState(nativeState, managedContext.accepted);
      }
      managed = {
        authContent: projected.content,
        authSecrets: projected.secrets,
        nativeState,
        accepted: managedContext.accepted,
      };
    }

    const assistantMessageId = generateId() as MessageID;
    const permissionLocks = new Map<SessionID, Promise<void>>();
    const tool = new OpenCodeTool({
      resolveMcpServers: async (targetSessionId) => {
        const reporter = collectWithheldMcpServers();
        const servers = await getMcpServersForSession(
          targetSessionId,
          {
            sessionMCPRepo: repos.sessionMCP,
            mcpServerRepo: repos.mcpServers,
            mcpOAuthAuthHeadersRepo: repos.mcpOAuthAuthHeaders,
            forUserId: contextUserId,
            onServerWithheld: reporter.onServerWithheld,
          },
          // OpenCode's invocation config still carries no per-tool filter, but
          // every MCP tool call comes back through Agor before it runs: the
          // managed server asks permission using the tool's own key as the
          // permission type, and Agor mints that key when it registers the
          // server, so the match is exact. Enforcement happens there
          // (`applyPermissionEffect`) instead of by withholding the server.
          { toolFiltering: 'intercept' }
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
          permissionLocks,
          mcpServerRepo: repos.mcpServers,
          sessionMCPRepo: repos.sessionMCP,
          // Deliberately empty. This callback only ever sees OpenCode's own
          // permission keys (`<server key>_<tool>`), which the namespaced
          // `mcp__server__tool` resolver cannot match -- and a miss would read
          // as "unconfigured", i.e. allow. The per-tool gate for this handler
          // lives in `applyPermissionEffect`, keyed the way OpenCode names
          // things, and runs before this callback is reached.
          mcpToolPermissions: EMPTY_MCP_TOOL_PERMISSION_INDEX,
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
        // Managed turns resume only the accepted checkpoint's native session;
        // an unpublished sdk_session_id from a failed turn is never reused.
        existingOpenCodeSessionId: managed
          ? (managed.accepted?.openCodeSessionId ?? undefined)
          : session.sdk_session_id,
        title: session.title || `Task ${shortId(taskId)}`,
        directory: branch.path,
        provider: session.model_config.provider,
        model: session.model_config.model,
        effort: session.model_config.effort,
        mcpToken: session.mcp_token,
        permissionMode: params.permissionMode,
        signal: params.abortController.signal,
        dataHome,
        managed,
        persistOpenCodeSessionId: async (openCodeSessionId) => {
          await client.service('sessions').patch(sessionId, { sdk_session_id: openCodeSessionId });
        },
      },
      createStreamingCallbacks(client, 'opencode', sessionId, taskId, params.onPulse)
    );

    if (params.abortController.signal.aborted) return;
    if (managed && !result.nativeStateAttempt) {
      throw new Error('OpenCode managed turn completed without a published checkpoint');
    }

    const finalIndex = await repos.messages.getNextIndexBySessionId(sessionId);
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
    await client.service('tasks').patch(taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      model: `${session.model_config.provider}/${session.model_config.model}`,
      // The daemon accepts this pointer only together with completion, Session
      // lock first; a terminal task refuses it (stale writer fence).
      ...(result.nativeStateAttempt ? { native_state_attempt: result.nativeStateAttempt } : {}),
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error('[opencode] execution failed category=task_execution');

    if (isOpenCodeCleanupUnverifiedError(failure)) {
      // Keep the task active. Executor exit hands containment to the daemon;
      // making it terminal here would release the session before absence is proven.
      return;
    }
    if (!params.abortController.signal.aborted) {
      await settleTaskFailure(client, sessionId, taskId, failure, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: failure.message,
      });
    }
    throw failure;
  } finally {
    globalPermissionManager.unregister(sessionId);
    if (managedScratch) await discardOpenCodeScratch(managedScratch);
  }
}
