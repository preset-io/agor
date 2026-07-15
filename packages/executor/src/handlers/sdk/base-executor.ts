/**
 * Base Executor - Shared execution logic for all SDK tools
 *
 * This module provides shared helpers to reduce duplication across
 * Claude, Codex, Gemini, and OpenCode executors.
 */

import {
  AGOR_USER_ENV_KEYS_VAR,
  type ApiKeyName,
  stripProviderCredentialEnvironment,
} from '@agor/core/config';
import { generateId, shortId } from '@agor/core/db';
import type {
  AgenticToolName,
  ContextUsageSnapshot,
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  StreamingEventType,
  Task,
  TaskID,
} from '@agor/core/types';
import { MessageRole, PROVIDER_CREDENTIAL_FIELDS } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import { getCurrentBranch, getGitState } from '../../git/index.js';
import type { StreamingCallbacks } from '../../sdk-handlers/base/types.js';
import { normalizeRawSdkResponse } from '../../sdk-handlers/normalizer-factory.js';
import type { AgorClient } from '../../services/feathers-client.js';
import { configureSessionGitSafeDirectories } from './git-safe-directory.js';

const DEBUG_SDK_EXECUTOR =
  process.env.AGOR_DEBUG_SDK_EXECUTOR === '1' || process.env.DEBUG?.includes('sdk-executor');

function sdkDebug(...args: unknown[]): void {
  if (DEBUG_SDK_EXECUTOR) {
    console.debug(...args);
  }
}

/**
 * Tool interface that all SDK wrappers must implement
 */
export interface BaseTool {
  executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    callbacks?: StreamingCallbacks,
    abortController?: AbortController,
    messageSource?: MessageSource
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    };
    wasStopped?: boolean;
    /** Whether the SDK returned an error result (e.g., error_during_execution) */
    hadError?: boolean;
    /** Error details from SDK when hadError is true */
    errorDetails?: string[];
    /** Raw SDK response for token accounting - stored and normalized */
    rawSdkResponse?: unknown;
    /**
     * Authoritative context-window snapshot captured during the turn.
     * - Claude: from the Agent SDK's `getContextUsage()` response.
     * - Codex: from the CLI's `event_msg/token_count.last_token_usage` payload.
     * When present, base-executor uses it as the source of truth for
     * `Task.computed_context_window` and `normalized_sdk_response.contextUsageSnapshot`.
     */
    rawContextUsage?: ContextUsageSnapshot;
    /**
     * Resolved model the tool actually invoked. Leave undefined when
     * unknown — never substitute a tool default. See
     * `sdk-handlers/base/model-recording.ts`.
     */
    model?: string;
  }>;

  // Optional stopTask method for tools that support interruption
  stopTask?(
    sessionId: SessionID,
    taskId?: TaskID
  ): Promise<{
    success: boolean;
    partialResult?: Partial<{ taskId: string; status: 'completed' | 'failed' | 'cancelled' }>;
    reason?: string;
  }>;

  /**
   * Fallback: compute current context-window occupancy for a session.
   *
   * Only invoked when no authoritative `rawContextUsage` snapshot was
   * captured during the turn. See the canonical doc on
   * `ITool.computeContextWindow` in `sdk-handlers/base/tool.interface.ts`
   * for the full source-precedence rules and per-tool strategy notes.
   */
  computeContextWindow?(
    sessionId: string,
    currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number>;
}

/**
 * Execution context containing all necessary resources for SDK execution
 */
export interface ExecutionContext {
  client: AgorClient;
  repos: ReturnType<typeof createFeathersBackedRepositories>;
  callbacks: StreamingCallbacks;
}

/**
 * Create streaming callbacks that call daemon custom route to broadcast events
 *
 * IMPORTANT: Executors cannot emit events directly - they must call a custom route
 * which then uses app.service().emit() to trigger the daemon's app.publish() system.
 * See: context/guides/extending-feathers-services.md
 */
export function createStreamingCallbacks(
  client: AgorClient,
  toolName: string,
  sessionId: SessionID
): StreamingCallbacks {
  // Use session_id passed in (available before any streaming starts)
  // This ensures thinking events have session_id even if they fire before onStreamStart
  const currentSessionId: SessionID = sessionId;

  // Track sequence numbers per message for ordering guarantees
  const sequenceCounters = new Map<string, number>();

  // Helper to broadcast streaming events via custom route
  const broadcastEvent = async (event: StreamingEventType, data: Record<string, unknown>) => {
    await client.service('/messages/streaming').create({
      event,
      data,
    });
  };

  return {
    onStreamStart: async (message_id, data) => {
      // Initialize sequence counter for this message
      sequenceCounters.set(message_id, 0);

      await broadcastEvent('streaming:start', {
        message_id,
        session_id: currentSessionId,
        task_id: data.task_id,
        role: data.role,
        timestamp: data.timestamp,
      });
    },
    onStreamChunk: async (message_id, chunk, _sequenceOverride?: number) => {
      // Get and increment sequence number for this message
      const currentSeq = sequenceCounters.get(message_id) || 0;
      const sequence = _sequenceOverride !== undefined ? _sequenceOverride : currentSeq;
      sequenceCounters.set(message_id, sequence + 1);

      await broadcastEvent('streaming:chunk', {
        message_id,
        session_id: currentSessionId,
        chunk,
        sequence, // Add sequence number for ordering
      });
    },
    onStreamEnd: async (message_id) => {
      // Get final sequence number for this message
      const finalSequence = sequenceCounters.get(message_id) || 0;

      await broadcastEvent('streaming:end', {
        message_id,
        session_id: currentSessionId,
        sequence: finalSequence, // Include final sequence for validation
      });

      // Clean up sequence counter
      sequenceCounters.delete(message_id);
    },
    onStreamError: async (message_id, error) => {
      console.error(`[${toolName}] Stream error for ${message_id}:`, error);
      await broadcastEvent('streaming:error', {
        message_id,
        session_id: currentSessionId,
        error: error.message,
      });
    },
    onThinkingStart: async (message_id, metadata) => {
      await broadcastEvent('thinking:start', {
        message_id,
        session_id: currentSessionId,
        ...metadata,
      });
    },
    onThinkingChunk: async (message_id, chunk) => {
      await broadcastEvent('thinking:chunk', {
        message_id,
        session_id: currentSessionId,
        chunk,
      });
    },
    onThinkingEnd: async (message_id) => {
      await broadcastEvent('thinking:end', {
        message_id,
        session_id: currentSessionId,
      });
    },
  };
}

/**
 * Create execution context with all necessary resources
 */
export function createExecutionContext(
  client: AgorClient,
  toolName: string,
  sessionId: SessionID
): ExecutionContext {
  return {
    client,
    repos: createFeathersBackedRepositories(client),
    callbacks: createStreamingCallbacks(client, toolName, sessionId),
  };
}

type CapturedGitState = {
  sha: string;
  ref: string;
};

/**
 * Capture git state from inside the executor process.
 *
 * The daemon should not run git inside managed branch checkouts just to stamp
 * task bookkeeping. The executor is already running with the correct Unix
 * identity/environment, so task start/end snapshots belong here.
 */
async function captureGitStateForSession(
  client: AgorClient,
  sessionId: SessionID,
  phase: 'start' | 'end'
): Promise<CapturedGitState | undefined> {
  try {
    const session = await client.service('sessions').get(sessionId);
    if (!session.branch_id) {
      console.warn(`[Git SHA Capture] Session has no branch_id at task ${phase}`);
      return undefined;
    }

    const branch = await client.service('branches').get(session.branch_id);
    if (!branch.path) {
      console.warn(`[Git SHA Capture] Branch has no path at task ${phase}`);
      return undefined;
    }

    const sha = await getGitState(branch.path);
    let ref = 'unknown';
    try {
      ref = await getCurrentBranch(branch.path);
    } catch (error) {
      console.warn(
        `[Git SHA Capture] Failed to capture git ref at task ${phase}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    console.log(
      `[Git SHA Capture] Captured git state at task ${phase}: ${sha.substring(0, 8)}${sha.endsWith('-dirty') ? ' (dirty)' : ''} ref=${ref}`
    );

    // Update session's current_sha to keep it in sync as tasks complete.
    if (phase === 'end' && sha && sha !== 'unknown') {
      try {
        await client.service('sessions').patch(sessionId, {
          git_state: { ...session.git_state, current_sha: sha, ref },
        });
      } catch (sessionPatchError) {
        console.warn('[Git SHA Capture] Failed to update session current_sha:', sessionPatchError);
      }
    }

    return { sha, ref };
  } catch (error) {
    console.warn(`[Git SHA Capture] Failed to capture git state at task ${phase}:`, error);
    return undefined;
  }
}

export async function captureGitStateAtTaskEnd(
  client: AgorClient,
  sessionId: SessionID
): Promise<string | undefined> {
  const gitState = await captureGitStateForSession(client, sessionId, 'end');
  return gitState?.sha;
}

export async function stampGitStateAtTaskStart(
  client: AgorClient,
  sessionId: SessionID,
  taskId: TaskID
): Promise<void> {
  const gitState = await captureGitStateForSession(client, sessionId, 'start');
  if (!gitState) return;

  try {
    await client.service('tasks').patch(taskId, {
      git_state: {
        ref_at_start: gitState.ref,
        sha_at_start: gitState.sha,
      },
    });
  } catch (error) {
    console.warn('[Git SHA Capture] Failed to stamp task start git state:', error);
  }
}

/**
 * Resolve API key with proper precedence:
 * 1. Per-user encrypted keys (from database) - HIGHEST
 * 2. Global config.yaml keys - MEDIUM
 * 3. Environment variables - LOW
 * 4. SDK native auth (OAuth, CLI login) - FALLBACK
 *
 * Returns resolution result with key, source, and useNativeAuth flag
 */
export async function resolveApiKeyForTask(
  keyName: ApiKeyName,
  client: AgorClient,
  taskId: TaskID,
  tool: AgenticToolName
): Promise<import('@agor/core/config').KeyResolutionResult> {
  // Call daemon service to resolve API key (no direct database access from executor!)
  // This allows executors to run as different Unix users without needing database access.
  // `tool` scopes the per-user lookup to the calling SDK's bucket so a Codex spawn
  // never resolves a key stored under `agentic_tools['claude-code']`, and vice versa.
  const executorSessionToken = (client as AgorClient & { executorSessionToken?: string })
    .executorSessionToken;
  const result = (await client.service('config/resolve-api-key').create({
    taskId,
    keyName,
    tool,
    ...(executorSessionToken ? { executorSessionToken } : {}),
  })) as import('@agor/core/config').KeyResolutionResult;
  sdkDebug(`[API Key Resolution] Resolved ${keyName} via daemon (source: ${result.source})`);
  return result;
}

/** Exported for tests. Mutates process.env — production callers: executeToolTask only. */
export function installProviderConnection(
  tool: AgenticToolName,
  connection: Record<string, string | undefined>
): void {
  // Strip only THIS tool's provider surface (fields + ambient aliases) so the
  // resolved connection is the sole credential its SDK can see. Everything
  // else — notably user-configured env vars like GITHUB_TOKEN — survives.
  const sanitized = stripProviderCredentialEnvironment(process.env, tool);
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(sanitized, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(connection)) {
    if (value?.trim()) process.env[key] = value;
  }
  // Keep AGOR_USER_ENV_KEYS truthful: drop names that no longer exist so MCP
  // template resolution doesn't advertise vars this strip just removed.
  const advertisedKeys = process.env[AGOR_USER_ENV_KEYS_VAR];
  if (advertisedKeys) {
    const remaining = advertisedKeys.split(',').filter((key) => process.env[key] !== undefined);
    if (remaining.length > 0) {
      process.env[AGOR_USER_ENV_KEYS_VAR] = remaining.join(',');
    } else {
      delete process.env[AGOR_USER_ENV_KEYS_VAR];
    }
  }
}

function hasProviderCredential(
  tool: AgenticToolName,
  connection: Record<string, string | undefined>
): boolean {
  const canonicalTool = tool === 'claude-code-cli' ? 'claude-code' : tool;
  if (!(canonicalTool in PROVIDER_CREDENTIAL_FIELDS)) return false;
  return PROVIDER_CREDENTIAL_FIELDS[canonicalTool as keyof typeof PROVIDER_CREDENTIAL_FIELDS].some(
    (field) => connection[field]?.trim()
  );
}

/**
 * Execute a tool task - shared implementation for all SDK tools
 */
export async function executeToolTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  apiKeyEnvVar: ApiKeyName;
  toolName: AgenticToolName;
  messageSource?: MessageSource;
  createTool: (
    repos: ReturnType<typeof createFeathersBackedRepositories>,
    apiKey: string,
    useNativeAuth: boolean
  ) => BaseTool;
}): Promise<void> {
  const { client, sessionId, taskId, prompt, permissionMode, apiKeyEnvVar, toolName, createTool } =
    params;

  console.log(`[${toolName}] Executing task ${shortId(taskId)}...`);

  // Ensure plain git commands launched by the agent SDK inherit safe.directory
  // trust for this managed checkout. Without this, Unix-isolated sessions can
  // create and run successfully through executor-mediated git probes while
  // `git status` inside the agent shell still fails with dubious ownership.
  await configureSessionGitSafeDirectories(client, sessionId, `[${toolName} git.safe-directory]`);

  // Capture and stamp task-start git state inside the executor as early as
  // possible. The daemon transitions the task to RUNNING before spawn, but the
  // authoritative branch git read belongs here with the rest of
  // executor-mediated git work.
  await stampGitStateAtTaskStart(client, sessionId, taskId);

  // Resolve one complete user-or-tenant provider connection.
  const resolution = await resolveApiKeyForTask(apiKeyEnvVar, client, taskId, toolName);
  const connection = {
    ...(resolution.connection ?? {}),
    ...(resolution.apiKey ? { [apiKeyEnvVar]: resolution.apiKey } : {}),
  } as Record<string, string | undefined>;
  installProviderConnection(toolName, connection);

  // Fail fast if stored key can't be decrypted (e.g. master secret changed)
  if (resolution.decryptionFailed) {
    throw new Error(
      `API key "${apiKeyEnvVar}" could not be decrypted. ` +
        `The stored key may have been encrypted with a different master secret. ` +
        `Please re-enter your API key in Settings > ${toolName} > Authentication.`
    );
  }
  if (!hasProviderCredential(toolName, connection) && !resolution.useNativeAuth) {
    throw new Error(`No scoped ${toolName} credential is configured for this workspace or user.`);
  }

  // Log resolution result
  if (resolution.apiKey) {
    sdkDebug(`[${toolName}] Using API key from ${resolution.source} level for ${apiKeyEnvVar}`);
  } else {
    sdkDebug(`[${toolName}] No scoped provider API key is configured`);
  }

  // Create execution context
  const ctx = createExecutionContext(client, toolName, sessionId);

  // Create tool instance using factory function
  // Pass the resolved key (or empty string) and useNativeAuth flag
  const tool = createTool(ctx.repos, resolution.apiKey || '', resolution.useNativeAuth);

  // Wire up abort signal to tool's stopTask method.
  // Triggered by SIGTERM handler calling abortController.abort().
  const abortHandler = async () => {
    console.log(`[${toolName}] Abort signal received, calling tool.stopTask()...`);
    if (tool.stopTask) {
      try {
        const stopResult = await tool.stopTask(sessionId, taskId);
        if (stopResult.success) {
          console.log(`[${toolName}] Tool stopped successfully`);
        } else {
          console.warn(`[${toolName}] Tool stop failed: ${stopResult.reason}`);
        }
      } catch (error) {
        console.error(`[${toolName}] Error calling stopTask:`, error);
      }
    } else {
      console.warn(`[${toolName}] Tool does not implement stopTask method`);
    }
  };

  // Handle race condition: if signal is already aborted, call handler immediately
  if (params.abortController.signal.aborted) {
    await abortHandler();
  }

  // Listen for abort signal
  params.abortController.signal.addEventListener('abort', abortHandler);

  try {
    // Execute prompt with streaming
    // Pass abortController directly to SDK for proper cancellation support
    const result = await tool.executePromptWithStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      ctx.callbacks,
      params.abortController,
      params.messageSource
    );

    console.log(
      `[${toolName}] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
    );

    // Capture git SHA at task end
    const gitStateAtEnd = await captureGitStateForSession(client, sessionId, 'end');

    // Determine task status based on SDK result
    // - wasStopped: user explicitly stopped the task
    // - hadError: SDK returned an error subtype (e.g., error_during_execution)
    const taskStatus = result.wasStopped ? 'stopped' : result.hadError ? 'failed' : 'completed';

    if (result.hadError) {
      console.error(
        `[${toolName}] SDK returned error result for session ${shortId(sessionId)}, marking task as failed${result.errorDetails?.length ? `: ${result.errorDetails.join('; ')}` : ''}`
      );
    }

    // Build patch data
    const patchData: Partial<Task> = {
      status: taskStatus,
      completed_at: new Date().toISOString(),
    };

    // Add git_state if we captured a SHA
    // Note: This will be deep-merged with existing git_state by the repository layer
    if (gitStateAtEnd) {
      // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
      patchData.git_state = {
        sha_at_end: gitStateAtEnd.sha,
      };
    }

    // Add SDK response data for token accounting
    // Store both raw (for debugging) and normalized (for UI/analytics)
    if (result.rawSdkResponse) {
      patchData.raw_sdk_response = result.rawSdkResponse;
      // `modelHint` refines context-window lookup for tools whose SDK
      // event omits the model; never used as primaryModel.
      const normalized = normalizeRawSdkResponse(toolName, result.rawSdkResponse, {
        modelHint: result.model,
      });
      if (normalized) {
        patchData.normalized_sdk_response = normalized;
        console.log(
          `[${toolName}] Normalized SDK response: ${normalized.tokenUsage.totalTokens} tokens, $${normalized.costUsd?.toFixed(4) ?? 'N/A'}`
        );
      }
    }

    // result.model (configured) wins over normalizer's primaryModel (SDK echo).
    const resolvedTaskModel = result.model || patchData.normalized_sdk_response?.primaryModel;
    if (resolvedTaskModel) {
      patchData.model = resolvedTaskModel;
      console.log(`[${toolName}] Task model set to: ${resolvedTaskModel}`);
    }

    // Prefer the authoritative context-window snapshot when the tool surfaced
    // one (Claude: Agent SDK getContextUsage(); Codex: CLI event_msg/token_count
    // last_token_usage). Falls back to tool-specific computation otherwise.
    // Handled independently of rawSdkResponse — the two data sources are separate.
    //
    // The `maxTokens > 0` guard (vs `totalTokens > 0`) preserves the snapshot
    // even at the moment of auto-compaction, when `totalTokens` can legitimately
    // be near zero.
    if (result.rawContextUsage && result.rawContextUsage.maxTokens > 0) {
      patchData.computed_context_window = result.rawContextUsage.totalTokens;
      console.log(
        `[${toolName}] Authoritative context snapshot: ${result.rawContextUsage.totalTokens}/${result.rawContextUsage.maxTokens} tokens (${result.rawContextUsage.percentage}%)`
      );

      // Override contextWindowLimit in the normalized response with the
      // authoritative maxTokens so the UI computes percentage against the
      // model's actual reported window, and attach the snapshot itself so
      // UI consumers can prefer the agent's own displayed percentage.
      if (patchData.normalized_sdk_response) {
        patchData.normalized_sdk_response.contextWindowLimit = result.rawContextUsage.maxTokens;
        patchData.normalized_sdk_response.contextUsageSnapshot = result.rawContextUsage;
      }
    } else {
      // No authoritative event_msg/token_count snapshot was captured during the
      // turn. Fall through to the tool's `computeContextWindow()` which uses a
      // last-resort heuristic. The previous "running totals across tasks" path
      // was removed — it relied on subtracting prior tasks' input_tokens, but
      // each turn.completed.input_tokens already includes the full transcript,
      // so the delta represents "new content this turn," not occupancy.
      if (patchData.computed_context_window === undefined && tool.computeContextWindow) {
        try {
          const contextWindow = await tool.computeContextWindow(
            sessionId,
            taskId,
            result.rawSdkResponse
          );
          if (contextWindow > 0) {
            patchData.computed_context_window = contextWindow;
            console.log(`[${toolName}] Computed context window: ${contextWindow} tokens`);
          }
        } catch (error) {
          console.error(`[${toolName}] Failed to compute context window:`, error);
          // Continue without context window - not critical
        }
      }
    }

    // Update task status to completed/stopped with git SHA and SDK responses
    // Note: The stop endpoint may have already patched task to STOPPED via process kill.
    // The tasks.ts patch hook guards against double-updates (wasAlreadyTerminal check).
    await client.service('tasks').patch(taskId, patchData);
  } catch (error) {
    const err = error as Error;
    console.error(`[${toolName}] Execution failed:`, err);

    // Capture git SHA at task end (even for failed tasks)
    const gitStateAtEnd = await captureGitStateForSession(client, sessionId, 'end');

    // Build patch data
    const patchData: Partial<Task> = {
      status: 'failed',
      completed_at: new Date().toISOString(),
      // Surface the actual failure reason so the UI / DB show what went wrong,
      // instead of the task silently flipping to FAILED with no context.
      error_message: err.message || String(err),
    };

    // Add git_state if we captured a SHA
    // Note: This will be deep-merged with existing git_state by the repository layer
    if (gitStateAtEnd) {
      // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
      patchData.git_state = {
        sha_at_end: gitStateAtEnd.sha,
      };
    }

    // Update task status to failed with git SHA
    await client.service('tasks').patch(taskId, patchData);

    // Emit a system error message so the user sees what went wrong in the conversation
    try {
      const existingMessages = await client.service('messages').find({
        query: { session_id: sessionId, $limit: 0 },
      });
      const messageCount =
        typeof existingMessages === 'object' && 'total' in existingMessages
          ? existingMessages.total
          : Array.isArray(existingMessages)
            ? existingMessages.length
            : 0;

      await client.service('messages').create({
        message_id: generateId() as MessageID,
        session_id: sessionId,
        task_id: taskId,
        type: 'system',
        role: MessageRole.SYSTEM,
        index: messageCount,
        timestamp: new Date().toISOString(),
        content: err.message,
        content_preview: err.message.substring(0, 200),
      });
    } catch (msgErr) {
      console.error(`[${toolName}] Failed to create error message:`, msgErr);
    }

    throw err;
  } finally {
    // Clean up abort listener
    params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}
