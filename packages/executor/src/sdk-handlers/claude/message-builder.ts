/**
 * Message Builder Utilities for Claude Tool
 *
 * Helper functions for creating and managing messages in the database.
 * Handles user messages, assistant messages, and token usage extraction.
 */

import { generateId } from '@agor/core';
import type { Message, MessageID, MessageSource, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { TokenUsage } from '../../types/token-usage.js';
import type { MessagesService, TasksService } from './claude-tool.js';
import { DEFAULT_CLAUDE_MODEL } from './models.js';

/**
 * Safely extract and validate token usage from SDK response
 * SDK may not properly type this field, so we validate at runtime
 *
 * Note: SDK uses different field names than Anthropic API:
 * - cache_creation_input_tokens → cache_creation_tokens
 * - cache_read_input_tokens → cache_read_tokens
 */
export function extractTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;
  return {
    input_tokens: typeof obj.input_tokens === 'number' ? obj.input_tokens : undefined,
    output_tokens: typeof obj.output_tokens === 'number' ? obj.output_tokens : undefined,
    total_tokens: typeof obj.total_tokens === 'number' ? obj.total_tokens : undefined,
    cache_read_tokens:
      typeof obj.cache_read_input_tokens === 'number' ? obj.cache_read_input_tokens : undefined,
    cache_creation_tokens:
      typeof obj.cache_creation_input_tokens === 'number'
        ? obj.cache_creation_input_tokens
        : undefined,
  };
}

/**
 * Create user message in database (from text prompt).
 *
 * Idempotency (Alt D — "never lose a prompt"): when `options.existingMessages` is
 * provided AND a user message already exists for this `taskId`, this returns the
 * pre-existing row WITHOUT inserting. This lets the executor remain a safe
 * fallback writer even after the daemon adopts the user-message write up-front
 * inside `POST /sessions/:id/prompt`.
 *
 * Callers should always pass `existingMessages` (the result of
 * `messagesRepo.findBySessionId(sessionId)` they already fetched to compute
 * `nextIndex`) so the guard can fire. The `nextIndex` argument is still used
 * for the freshly-created row's `index`; if the guard fires, callers should
 * recompute their next index from the returned message:
 *
 *   nextIndex = userMessage.index + 1;
 */
export async function createUserMessage(
  sessionId: SessionID,
  prompt: string,
  taskId: TaskID | undefined,
  nextIndex: number,
  messagesService: MessagesService,
  options?: {
    messageSource?: MessageSource;
    /**
     * Pre-fetched messages for this session. When provided, used to detect a
     * pre-existing user-message row for `taskId` and skip the insert.
     */
    existingMessages?: ReadonlyArray<Message>;
  }
): Promise<Message> {
  const { messageSource, existingMessages } = options ?? {};

  // Skip-if-exists guard (Alt D): if the daemon already wrote the initial
  // prompt row for this task, return it instead of inserting a duplicate.
  //
  // Match on `role === USER` regardless of `type`, because the daemon writes
  // callback prompts as `type:'system', role:'user'` (so the UI can apply the
  // Agor-callback styling) while normal prompts are `type:'user', role:'user'`.
  // A `type`-strict predicate misses callback rows and double-inserts the
  // prompt. Tool-result rows (also role:USER) cannot exist yet at executor
  // startup — this guard runs before any agent turn has produced output —
  // so role-only matching is safe here.
  if (taskId && existingMessages) {
    const existing = existingMessages.find(
      (m) => m.task_id === taskId && m.role === MessageRole.USER
    );
    if (existing) {
      return existing;
    }
  }

  const userMessage: Message = {
    message_id: generateId() as MessageID,
    session_id: sessionId,
    type: 'user',
    role: MessageRole.USER,
    index: nextIndex,
    timestamp: new Date().toISOString(),
    content_preview: prompt.substring(0, 200),
    content: prompt,
    task_id: taskId,
    metadata: messageSource ? { source: messageSource } : undefined,
  };

  await messagesService.create(userMessage);
  return userMessage;
}

/**
 * Create user message from SDK content (tool results, etc.)
 */
export async function createUserMessageFromContent(
  sessionId: SessionID,
  messageId: MessageID,
  content: Array<{
    type: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
  }>,
  taskId: TaskID | undefined,
  nextIndex: number,
  messagesService: MessagesService,
  parentToolUseId?: string | null
): Promise<Message> {
  // Extract preview from content
  let contentPreview = '';
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      contentPreview = block.text.substring(0, 200);
      break;
    } else if (block.type === 'tool_result' && block.content) {
      const resultText =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      contentPreview = `Tool result: ${resultText.substring(0, 180)}`;
      break;
    }
  }

  const userMessage: Message = {
    message_id: messageId,
    session_id: sessionId,
    type: 'user',
    role: MessageRole.USER,
    index: nextIndex,
    timestamp: new Date().toISOString(),
    content_preview: contentPreview,
    content: content as Message['content'], // Tool result blocks
    task_id: taskId,
    parent_tool_use_id: parentToolUseId || undefined,
  };

  await messagesService.create(userMessage);
  return userMessage;
}

/**
 * Create complete assistant message in database
 */
export async function createAssistantMessage(
  sessionId: SessionID,
  messageId: MessageID,
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>,
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined,
  taskId: TaskID | undefined,
  nextIndex: number,
  resolvedModel: string | undefined,
  messagesService: MessagesService,
  tasksService?: TasksService,
  parentToolUseId?: string | null,
  tokenUsage?: TokenUsage
): Promise<Message> {
  // Extract text content for preview
  const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text || '');
  const fullTextContent = textBlocks.join('');
  const contentPreview = fullTextContent.substring(0, 200);

  const message: Message = {
    message_id: messageId,
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: nextIndex,
    timestamp: new Date().toISOString(),
    content_preview: contentPreview,
    content: content as Message['content'],
    tool_uses: toolUses,
    task_id: taskId,
    parent_tool_use_id: parentToolUseId || undefined,
    metadata: {
      model: resolvedModel || DEFAULT_CLAUDE_MODEL,
      tokens: {
        input: tokenUsage?.input_tokens ?? 0,
        output: tokenUsage?.output_tokens ?? 0,
      },
    },
  };

  await messagesService.create(message);

  // If task exists, update it with resolved model
  if (taskId && resolvedModel && tasksService) {
    await tasksService.patch(taskId, { model: resolvedModel });
  }

  return message;
}

/**
 * Extract content preview from content blocks
 */
function extractContentPreview(
  content: Array<{
    type: string;
    text?: string;
    status?: string;
  }>
): string {
  // For system_status blocks, return status-specific preview
  const statusBlock = content.find((b) => b.type === 'system_status');
  if (statusBlock?.status === 'compacting') {
    return 'Compacting conversation context...';
  }

  // For any block with a text field, return text preview
  const textContent = content
    .filter((b) => b.text)
    .map((b) => b.text || '')
    .join('');
  return textContent.substring(0, 200);
}

/**
 * Create system message in database (for compaction, etc.)
 */
export async function createSystemMessage(
  sessionId: SessionID,
  messageId: MessageID,
  content: Array<{
    type: string;
    text?: string;
    status?: string;
    [key: string]: unknown; // Allow additional properties for system_complete, etc.
  }>,
  taskId: TaskID | undefined,
  nextIndex: number,
  resolvedModel: string | undefined,
  messagesService: MessagesService
): Promise<Message> {
  const message: Message = {
    message_id: messageId,
    session_id: sessionId,
    type: 'system',
    role: MessageRole.SYSTEM,
    index: nextIndex,
    timestamp: new Date().toISOString(),
    content_preview: extractContentPreview(content),
    content: content as Message['content'],
    task_id: taskId,
    metadata: {
      model: resolvedModel || DEFAULT_CLAUDE_MODEL,
      is_meta: true, // Mark as synthetic system message
    },
  };

  await messagesService.create(message);
  return message;
}
