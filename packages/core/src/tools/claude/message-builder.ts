/**
 * Message Builder Utilities for Claude Tool
 *
 * Helper functions for creating and managing messages in the database.
 * Handles user messages, assistant messages, and token usage extraction.
 */

import { generateId } from '../../lib/ids';
import type { Message, MessageID, SessionID, TaskID } from '../../types';
import { MessageRole } from '../../types';
import type { TokenUsage } from '../../utils/pricing';
import type { MessagesService, TasksService } from './claude-tool';
import { DEFAULT_CLAUDE_MODEL } from './models';

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
 * Create user message in database (from text prompt)
 */
export async function createUserMessage(
  sessionId: SessionID,
  prompt: string,
  taskId: TaskID | undefined,
  nextIndex: number,
  messagesService: MessagesService
): Promise<Message> {
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
  const textBlocks = content.filter(b => b.type === 'text').map(b => b.text || '');
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
  const statusBlock = content.find(b => b.type === 'system_status');
  if (statusBlock?.status === 'compacting') {
    return 'Compacting conversation context...';
  }

  // For text blocks, return text preview
  const textBlocks = content.filter(b => b.type === 'text').map(b => b.text || '');
  const fullTextContent = textBlocks.join('');
  return fullTextContent.substring(0, 200);
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
