/**
 * Oh My Pi (OMP) SDK Handler
 *
 * Executes prompts by driving the `omp` binary over its JSONL RPC protocol.
 *
 * Like OpenCode, OMP is keyless from Agor's perspective — it resolves its own
 * credentials from its profile — so this runner does not go through
 * `executeToolTask`, whose credential gate would reject a session that has no
 * Agor-stored API key.
 */

import { generateId, shortId } from '@agor/core';
import { AGOR_OMP_PROFILE_ENV } from '@agor/core/omp';
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
import { OmpTool } from '../../sdk-handlers/omp/index.js';
import type { AgorClient } from '../../services/feathers-client.js';
import { createStreamingCallbacks } from './base-executor.js';

export async function executeOmpTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;
  let abortHandler: (() => void) | undefined;

  console.log(`[omp] Executing task ${shortId(taskId)}...`);

  try {
    const session = await client.service('sessions').get(sessionId);
    const repos = createFeathersBackedRepositories(client);
    const callbacks = createStreamingCallbacks(client, 'omp', sessionId, params.onPulse);

    // Run the agent inside the branch worktree so its file tools operate on the
    // right checkout.
    let branchPath: string | undefined;
    if (session.branch_id) {
      try {
        const branch = await repos.branches.findById(session.branch_id);
        if (branch) branchPath = branch.path;
      } catch (error) {
        console.warn(`[omp] Could not resolve branch ${session.branch_id}:`, error);
      }
    }

    const tool = new OmpTool(
      {
        enabled: true,
        binPath: process.env.OMP_BIN_PATH || undefined,
        // Opt-in isolation; default inherits the host user's OMP login.
        profile: process.env[AGOR_OMP_PROFILE_ENV] || undefined,
      },
      repos.messagesService,
      repos.sessions
    );

    tool.setSessionContext({
      workingDirectory: branchPath,
      model: session.model_config?.model,
      provider: session.model_config?.provider,
      mcpToken: session.mcp_token,
      daemonUrl: await getDaemonUrl(),
      // Each task spawns a fresh OMP process; resuming the prior session file
      // is what preserves conversation context across turns.
      resumeRef: session.sdk_session_id ?? undefined,
    });

    abortHandler = () => {
      void tool.stopTask(sessionId, taskId).then((result) => {
        if (!result.success) console.warn(`[omp] Abort was not confirmed: ${result.reason}`);
      });
    };
    params.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    if (params.abortController.signal.aborted) abortHandler();

    const existingMessages = await client.service('messages').find({
      query: { session_id: sessionId, $sort: { index: 1 } },
    });
    const messages = Array.isArray(existingMessages) ? existingMessages : existingMessages.data;
    const nextIndex = messages?.length || 0;

    await repos.messagesService.create({
      message_id: generateId() as MessageID,
      session_id: sessionId,
      task_id: taskId,
      type: 'user' as const,
      role: MessageRole.USER,
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
    });

    const result = await tool.executeTask(sessionId, prompt, taskId, callbacks, nextIndex + 1);
    console.log(`[omp] Execution completed: status=${result.status}`);

    const modelIdentifier =
      session.model_config?.provider && session.model_config?.model
        ? `${session.model_config.provider}/${session.model_config.model}`
        : session.model_config?.model;

    if (!params.abortController.signal.aborted) {
      const contextUsage = tool.getLastContextUsage();
      await client.service('tasks').patch(taskId, {
        status: result.status === 'completed' ? 'completed' : 'failed',
        completed_at: new Date().toISOString(),
        model: modelIdentifier,
        ...(contextUsage ? { computed_context_window: contextUsage.totalTokens } : {}),
      });

      // Remember OMP's session file so the next task continues this thread.
      const sessionFile = tool.getLastSessionFile();
      if (sessionFile && sessionFile !== session.sdk_session_id) {
        await client.service('sessions').patch(sessionId, { sdk_session_id: sessionFile });
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[omp] Execution failed:', err);
    if (!params.abortController.signal.aborted) {
      await client.service('tasks').patch(taskId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
    }
    throw err;
  } finally {
    if (abortHandler) params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}
