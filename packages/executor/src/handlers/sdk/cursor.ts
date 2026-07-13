/**
 * Cursor SDK Handler (beta)
 *
 * Minimal local-runtime adapter for @cursor/sdk. Cursor is exposed as a beta
 * provider, so this first implementation favors a small, observable happy path:
 * local cwd = Agor branch worktree, SDK agent id persisted in sdk_session_id,
 * stream text/thinking/tool events into Agor messages, and cancel the active
 * Cursor run when Agor stops the executor.
 */

import { generateId, shortId } from '@agor/core/db';
import { DEFAULT_CURSOR_MODEL } from '@agor/core/models';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import type {
  ContentBlock,
  Message,
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  Task,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { Agent, type McpServerConfig, type Run, type SDKMessage } from '@cursor/sdk';
import { getDaemonUrl } from '../../config.js';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import { getMcpServersForSession } from '../../sdk-handlers/base/mcp-scoping.js';
import type { StreamingCallbacks } from '../../sdk-handlers/base/types.js';
import type { AgorClient } from '../../services/feathers-client.js';
import {
  captureGitStateAtTaskEnd,
  createStreamingCallbacks,
  stampGitStateAtTaskStart,
} from './base-executor.js';
import { configureSessionGitSafeDirectories } from './git-safe-directory.js';

type CursorKeyResolution = {
  apiKey?: string;
  source?: string;
  decryptionFailed?: boolean;
};

function stringifyForPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toCursorModel(model: string | undefined): { id: string } {
  return { id: model?.trim() || DEFAULT_CURSOR_MODEL };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeCursorToolName(name: string): string {
  switch (name.toLowerCase()) {
    case 'shell':
    case 'bash':
    case 'terminal':
    case 'run_terminal_cmd':
      return 'Bash';
    case 'read':
    case 'ls':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'delete':
      return 'Delete';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'update_todos':
      return 'TodoWrite';
    case 'task':
      return 'Task';
    default:
      return name;
  }
}

export function normalizeCursorToolInput(
  event: Extract<SDKMessage, { type: 'tool_call' }>
): Record<string, unknown> {
  const input = { ...asRecord(event.args) };
  const normalizedName = normalizeCursorToolName(event.name);

  // Preserve Cursor's native tool name when we map it to an Agor/Claude-ish
  // renderer name. This keeps raw provenance inspectable while unlocking
  // existing UI renderers like BashRenderer/EditRenderer/WriteRenderer.
  if (normalizedName !== event.name) {
    input.cursor_tool_name = event.name;
  }
  input.status = event.status;

  if (normalizedName === 'Bash' && input.command == null) {
    const command = input.cmd ?? input.script ?? input.shell ?? input.shellCommand ?? input.args;
    if (Array.isArray(command)) {
      input.command = command.map(String).join(' ');
    } else if (command != null) {
      input.command = String(command);
    }
  }

  if (
    (normalizedName === 'Read' ||
      normalizedName === 'Write' ||
      normalizedName === 'Edit' ||
      normalizedName === 'Delete') &&
    input.file_path == null
  ) {
    const path = input.path ?? input.file ?? input.target;
    if (path != null) {
      input.file_path = String(path);
    }
  }

  return input;
}

export function buildCursorAssistantContent(args: {
  text: string;
  thinkingText?: string;
}): ContentBlock[] {
  const content: ContentBlock[] = [];
  const normalizedText = args.text.trim().replace(/\s+/g, ' ');
  const normalizedThinkingText = args.thinkingText?.trim().replace(/\s+/g, ' ');

  // Cursor can emit answer-like content on `thinking` events for simple
  // prompts. Persist real reasoning when it differs from the final answer, but
  // avoid showing the same assistant answer twice (once as a thought, once as
  // normal text).
  if (args.thinkingText?.trim() && normalizedThinkingText !== normalizedText) {
    content.push({ type: 'thinking', text: args.thinkingText });
  }
  if (args.text) {
    content.push({ type: 'text', text: args.text });
  }
  return content;
}

function claimMcpName(rawName: string, claimed: Set<string>): string {
  const base = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'server';
  let name = base;
  let suffix = 2;
  while (claimed.has(name)) {
    name = `${base}_${suffix++}`;
  }
  claimed.add(name);
  return name;
}

async function resolveCursorApiKey(client: AgorClient, taskId: TaskID): Promise<string> {
  const result = (await client.service('config/resolve-api-key').create({
    taskId,
    keyName: 'CURSOR_API_KEY',
    tool: 'cursor',
  })) as CursorKeyResolution;

  if (result.decryptionFailed) {
    throw new Error(
      'CURSOR_API_KEY could not be decrypted. Re-enter it in Settings → Agent Setup → Cursor SDK.'
    );
  }

  const key = result.apiKey || process.env.CURSOR_API_KEY;
  if (!key) {
    throw new Error(
      'No CURSOR_API_KEY configured. Add one in Settings → Agent Setup → Cursor SDK.'
    );
  }

  console.log(`[cursor] Using CURSOR_API_KEY from ${result.source ?? 'environment'} level`);
  return key;
}

async function buildCursorMcpServers(args: {
  sessionId: SessionID;
  mcpToken?: string;
  repos: ReturnType<typeof createFeathersBackedRepositories>;
  forUserId?: string;
}): Promise<Record<string, McpServerConfig> | undefined> {
  const claimed = new Set<string>();
  const mcpServers: Record<string, McpServerConfig> = {};

  if (args.mcpToken) {
    const daemonUrl = await getDaemonUrl();
    claimed.add('agor');
    mcpServers.agor = {
      type: 'http',
      url: `${daemonUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${args.mcpToken}`,
      },
    };
  }

  const serversWithSource = await getMcpServersForSession(args.sessionId, {
    sessionMCPRepo: args.repos.sessionMCP,
    mcpServerRepo: args.repos.mcpServers,
    mcpOAuthAuthHeadersRepo: args.repos.mcpOAuthAuthHeaders,
    forUserId: args.forUserId,
  });

  for (const { server } of serversWithSource) {
    const name = claimMcpName(server.name, claimed);
    if (server.transport === 'stdio') {
      if (!server.command) {
        console.warn(`[cursor] Skipping MCP stdio server ${server.name}: missing command`);
        continue;
      }
      mcpServers[name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
      };
      continue;
    }

    if ((server.transport === 'http' || server.transport === 'sse') && server.url) {
      const authHeaders = await resolveMCPAuthHeaders(server.auth, server.url);
      const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
      mcpServers[name] = {
        type: server.transport,
        url: server.url,
        ...(headers ? { headers } : {}),
      };
    }
  }

  const count = Object.keys(mcpServers).length;
  console.log(`[cursor] Configured ${count} MCP server(s)`);
  return count > 0 ? mcpServers : undefined;
}

async function getSessionMessages(client: AgorClient, sessionId: SessionID): Promise<Message[]> {
  const existingMessages = await client.service('messages').find({
    query: {
      session_id: sessionId,
      $sort: { index: 1 },
    },
  });
  return Array.isArray(existingMessages) ? existingMessages : existingMessages.data;
}

function getNextMessageIndexFrom(messages: ReadonlyArray<Message>): number {
  return messages.length;
}

async function getNextMessageIndex(client: AgorClient, sessionId: SessionID): Promise<number> {
  return getNextMessageIndexFrom(await getSessionMessages(client, sessionId));
}

async function createUserMessage(args: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  index: number;
  messageSource?: MessageSource;
  existingMessages?: ReadonlyArray<Message>;
}): Promise<Message> {
  const existing = args.existingMessages?.find(
    (message) => message.task_id === args.taskId && message.role === MessageRole.USER
  );
  if (existing) {
    return existing;
  }

  const messageId = generateId() as MessageID;
  await args.client.service('messages').create({
    message_id: messageId,
    session_id: args.sessionId,
    task_id: args.taskId,
    type: 'user',
    role: MessageRole.USER,
    index: args.index,
    timestamp: new Date().toISOString(),
    content_preview: args.prompt.substring(0, 200),
    content: args.prompt,
    metadata: args.messageSource ? { source: args.messageSource } : undefined,
  });
  return {
    message_id: messageId,
    session_id: args.sessionId,
    task_id: args.taskId,
    type: 'user',
    role: MessageRole.USER,
    index: args.index,
    timestamp: new Date().toISOString(),
    content_preview: args.prompt.substring(0, 200),
    content: args.prompt,
    metadata: args.messageSource ? { source: args.messageSource } : undefined,
  };
}

async function createAssistantMessage(args: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  messageId: MessageID;
  index: number;
  content: string | ContentBlock[];
  preview: string;
  model?: string;
}): Promise<void> {
  await args.client.service('messages').create({
    message_id: args.messageId,
    session_id: args.sessionId,
    task_id: args.taskId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: args.index,
    timestamp: new Date().toISOString(),
    content_preview: args.preview.substring(0, 200),
    content: args.content,
    metadata: args.model ? { model: args.model } : undefined,
  });
}

function getToolMessageContent(event: Extract<SDKMessage, { type: 'tool_call' }>): {
  content: ContentBlock[];
  preview: string;
} {
  const resultText =
    event.result !== undefined ? stringifyForPreview(event.result) : `[${event.status}]`;
  const toolName = normalizeCursorToolName(event.name);
  const input = normalizeCursorToolInput(event);
  const content: ContentBlock[] = [
    {
      type: 'tool_use',
      id: event.call_id,
      name: toolName,
      input,
      status: event.status,
      ...(event.truncated ? { truncated: event.truncated } : {}),
    },
  ];

  if (event.status !== 'running') {
    content.push({
      type: 'tool_result',
      tool_use_id: event.call_id,
      content: resultText,
      is_error: event.status === 'error',
      ...(event.truncated ? { truncated: event.truncated } : {}),
    });
  }

  return {
    content,
    preview: `${toolName}: ${input.command ? String(input.command) : resultText}`,
  };
}

async function createToolMessage(args: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  index: number;
  event: Extract<SDKMessage, { type: 'tool_call' }>;
  model?: string;
}): Promise<MessageID> {
  const messageId = generateId() as MessageID;
  const { content, preview } = getToolMessageContent(args.event);

  await createAssistantMessage({
    client: args.client,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId,
    index: args.index,
    content,
    preview,
    model: args.model,
  });
  return messageId;
}

async function updateToolMessage(args: {
  client: AgorClient;
  messageId: MessageID;
  event: Extract<SDKMessage, { type: 'tool_call' }>;
}): Promise<void> {
  const { content, preview } = getToolMessageContent(args.event);
  await args.client.service('messages').patch(args.messageId, {
    content,
    content_preview: preview.substring(0, 200),
  });
}

async function createSystemErrorMessage(args: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  message: string;
}): Promise<void> {
  const index = await getNextMessageIndex(args.client, args.sessionId);
  await args.client.service('messages').create({
    message_id: generateId() as MessageID,
    session_id: args.sessionId,
    task_id: args.taskId,
    type: 'system',
    role: MessageRole.SYSTEM,
    index,
    timestamp: new Date().toISOString(),
    content: args.message,
    content_preview: args.message.substring(0, 200),
  });
}

/**
 * Execute Cursor task (Feathers/WebSocket architecture).
 */
export async function executeCursorTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  resolvedConfig?: ResolvedConfigSlice;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;

  console.log(`[cursor] Executing task ${shortId(taskId)}...`);
  if (params.permissionMode && params.permissionMode !== 'bypassPermissions') {
    console.warn(
      `[cursor] Ignoring permission mode "${params.permissionMode}"; @cursor/sdk currently runs autonomously in Agor.`
    );
  }

  let currentRun: Run | undefined;
  const abortHandler = () => {
    if (!currentRun) return;
    console.log(`[cursor] Abort signal received; cancelling Cursor run ${currentRun.id}`);
    currentRun.cancel().catch((error) => {
      console.warn('[cursor] Failed to cancel Cursor run:', error);
    });
  };
  params.abortController.signal.addEventListener('abort', abortHandler);

  try {
    await configureSessionGitSafeDirectories(client, sessionId, '[cursor git.safe-directory]');
    await stampGitStateAtTaskStart(client, sessionId, taskId);

    const apiKey = await resolveCursorApiKey(client, taskId);
    const session = await client.service('sessions').get(sessionId);
    const repos = createFeathersBackedRepositories(client);
    const callbacks = createStreamingCallbacks(client, 'cursor', sessionId);

    if (!session.branch_id) {
      throw new Error('Cursor sessions require a branch_id so the local runtime has a cwd.');
    }
    const branch = await client.service('branches').get(session.branch_id);
    if (!branch.path) {
      throw new Error('Cursor sessions require a branch worktree path.');
    }

    // configuredModel for recording, `model` (id form) for the SDK.
    const configuredModel = session.model_config?.model;
    const model = toCursorModel(configuredModel);
    const mcpServers = await buildCursorMcpServers({
      sessionId,
      mcpToken: session.mcp_token,
      repos,
      forUserId: session.created_by,
    });

    const agent = session.sdk_session_id
      ? await Agent.resume(session.sdk_session_id, {
          apiKey,
          model,
          local: { cwd: branch.path },
          mcpServers,
        })
      : await Agent.create({
          apiKey,
          model,
          name: session.title || `Agor ${shortId(sessionId)}`,
          local: { cwd: branch.path },
          mcpServers,
        });

    try {
      if (!session.sdk_session_id || session.sdk_session_id !== agent.agentId) {
        await client.service('sessions').patch(sessionId, { sdk_session_id: agent.agentId });
      }

      const existingMessages = await getSessionMessages(client, sessionId);
      const userMessage = await createUserMessage({
        client,
        sessionId,
        taskId,
        prompt,
        index: getNextMessageIndexFrom(existingMessages),
        messageSource: params.messageSource,
        existingMessages,
      });

      const assistantMessageId = generateId() as MessageID;
      let nextIndex = Math.max(getNextMessageIndexFrom(existingMessages), userMessage.index + 1);
      let assistantMessageIndex: number | undefined;
      const ensureAssistantMessageIndex = () => {
        assistantMessageIndex ??= nextIndex++;
        return assistantMessageIndex;
      };
      let assistantStreamStarted = false;
      let assistantText = '';
      let thinkingStarted = false;
      let thinkingText = '';
      const toolCallMessageIds: MessageID[] = [];
      const toolCallMessageIdsByCallId = new Map<string, MessageID>();
      const rawMessages: SDKMessage[] = [];

      currentRun = await agent.send(prompt, {
        model,
        mcpServers,
        idempotencyKey: taskId,
      });

      if (params.abortController.signal.aborted) {
        await currentRun.cancel();
      }

      for await (const event of currentRun.stream()) {
        rawMessages.push(event);
        if (params.abortController.signal.aborted) {
          await currentRun.cancel();
          break;
        }
        await handleCursorEvent({
          event,
          client,
          callbacks,
          sessionId,
          taskId,
          assistantMessageId,
          model: configuredModel,
          getNextIndex: () => nextIndex++,
          toolCallMessageIds,
          toolCallMessageIdsByCallId,
          getAssistantText: () => assistantText,
          setAssistantText: (value) => {
            assistantText = value;
          },
          getThinkingText: () => thinkingText,
          setThinkingText: (value) => {
            thinkingText = value;
          },
          isAssistantStreamStarted: () => assistantStreamStarted,
          setAssistantStreamStarted: (value) => {
            assistantStreamStarted = value;
          },
          ensureAssistantMessageIndex,
          isThinkingStarted: () => thinkingStarted,
          setThinkingStarted: (value) => {
            thinkingStarted = value;
          },
        });
      }

      if (assistantStreamStarted) {
        await callbacks.onStreamEnd(assistantMessageId);
      }
      if (thinkingStarted && callbacks.onThinkingEnd) {
        await callbacks.onThinkingEnd(assistantMessageId);
      }

      const runResult = await currentRun.wait();
      const resultText = typeof runResult.result === 'string' ? runResult.result : '';
      const finalText = resultText.length > assistantText.length ? resultText : assistantText;
      const finalContent = buildCursorAssistantContent({ text: finalText, thinkingText });
      // SDK echo > configured selection; undefined if neither.
      const recordedModel = runResult.model?.id ?? configuredModel;
      if (finalContent.length > 0) {
        await createAssistantMessage({
          client,
          sessionId,
          taskId,
          messageId: assistantMessageId,
          index: assistantMessageIndex ?? nextIndex++,
          content: finalContent,
          preview: finalText,
          model: recordedModel,
        });
      }

      const failed = runResult.status === 'error';
      const stopped = runResult.status === 'cancelled' || params.abortController.signal.aborted;
      const shaAtEnd = await captureGitStateAtTaskEnd(client, sessionId);
      const taskPatch: Partial<Task> = {
        status: stopped ? 'stopped' : failed ? 'failed' : 'completed',
        completed_at: new Date().toISOString(),
        ...(recordedModel ? { model: recordedModel } : {}),
        raw_sdk_response: {
          run: runResult,
          messages: rawMessages,
          agentId: agent.agentId,
          toolCallMessageIds,
        },
      };
      if (shaAtEnd) {
        // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
        taskPatch.git_state = { sha_at_end: shaAtEnd };
      }
      await client.service('tasks').patch(taskId, taskPatch);
    } finally {
      agent.close();
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[cursor] Execution failed:', err);
    const shaAtEnd = await captureGitStateAtTaskEnd(client, sessionId);
    const taskPatch: Partial<Task> = {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err.message,
    };
    if (shaAtEnd) {
      // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
      taskPatch.git_state = { sha_at_end: shaAtEnd };
    }
    await client.service('tasks').patch(taskId, taskPatch);
    await createSystemErrorMessage({ client, sessionId, taskId, message: err.message });
    throw err;
  } finally {
    params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}

async function handleCursorEvent(args: {
  event: SDKMessage;
  client: AgorClient;
  callbacks: StreamingCallbacks;
  sessionId: SessionID;
  taskId: TaskID;
  assistantMessageId: MessageID;
  /** Configured model from `session.model_config.model` — undefined when
   * the user never explicitly picked one. We persist this on recorded
   * tool messages; the SDK invocation model (with fallback) is owned by
   * the caller and not threaded through here. */
  model?: string;
  getNextIndex: () => number;
  toolCallMessageIds: MessageID[];
  toolCallMessageIdsByCallId: Map<string, MessageID>;
  getAssistantText: () => string;
  setAssistantText: (value: string) => void;
  getThinkingText: () => string;
  setThinkingText: (value: string) => void;
  isAssistantStreamStarted: () => boolean;
  setAssistantStreamStarted: (value: boolean) => void;
  ensureAssistantMessageIndex: () => number;
  isThinkingStarted: () => boolean;
  setThinkingStarted: (value: boolean) => void;
}): Promise<void> {
  switch (args.event.type) {
    case 'assistant': {
      const nextText = args.event.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const previousText = args.getAssistantText();
      const isCumulative = nextText.startsWith(previousText);
      const delta = isCumulative ? nextText.slice(previousText.length) : nextText;
      if (!delta) return;
      const updatedText = isCumulative ? nextText : previousText + nextText;

      if (!args.isAssistantStreamStarted()) {
        args.ensureAssistantMessageIndex();
        await args.callbacks.onStreamStart(args.assistantMessageId, {
          session_id: args.sessionId,
          task_id: args.taskId,
          role: MessageRole.ASSISTANT,
          timestamp: new Date().toISOString(),
        });
        args.setAssistantStreamStarted(true);
      }
      await args.callbacks.onStreamChunk(args.assistantMessageId, delta);
      args.setAssistantText(updatedText);
      return;
    }

    case 'thinking': {
      if (!args.callbacks.onThinkingChunk) return;
      const previousText = args.getThinkingText();
      const isCumulative = args.event.text.startsWith(previousText);
      const delta = isCumulative ? args.event.text.slice(previousText.length) : args.event.text;
      if (!delta) return;
      const updatedText = isCumulative ? args.event.text : previousText + args.event.text;

      if (!args.isThinkingStarted() && args.callbacks.onThinkingStart) {
        args.ensureAssistantMessageIndex();
        await args.callbacks.onThinkingStart(args.assistantMessageId, {});
        args.setThinkingStarted(true);
      }
      await args.callbacks.onThinkingChunk(args.assistantMessageId, delta);
      args.setThinkingText(updatedText);
      return;
    }

    case 'tool_call': {
      const existingMessageId = args.toolCallMessageIdsByCallId.get(args.event.call_id);
      if (existingMessageId) {
        await updateToolMessage({
          client: args.client,
          messageId: existingMessageId,
          event: args.event,
        });
        return;
      }

      const messageId = await createToolMessage({
        client: args.client,
        sessionId: args.sessionId,
        taskId: args.taskId,
        index: args.getNextIndex(),
        event: args.event,
        model: args.model,
      });
      args.toolCallMessageIdsByCallId.set(args.event.call_id, messageId);
      args.toolCallMessageIds.push(messageId);
      return;
    }

    case 'status':
    case 'system':
    case 'request':
    case 'task':
    case 'user':
      return;
  }
}
