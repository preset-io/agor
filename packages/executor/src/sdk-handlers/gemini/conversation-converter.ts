/**
 * Conversation Converter - Pure utility for converting Gemini CLI SDK conversation format to API format
 */

import type { GenAI } from '@agor/core/sdk';

type Content = GenAI.Content;
type Part = GenAI.Part;

/**
 * Convert SDK's ConversationRecord to Gemini Content[] format
 *
 * This converts the SDK's session file format into the API format needed for setHistory().
 * The SDK stores conversations with 'user' and 'gemini' message types, but the API expects
 * 'user' and 'model' roles.
 *
 * @param conversation - Conversation data from SDK session file
 * @returns Array of Content objects for Gemini API setHistory()
 */
export function convertConversationToHistory(conversation: {
  messages: Array<{
    type: string;
    content: unknown;
  }>;
}): Content[] {
  const history: Content[] = [];

  for (const msg of conversation.messages) {
    // Only process user and gemini messages (skip error, info, warning, etc.)
    if (msg.type !== 'user' && msg.type !== 'gemini') {
      continue;
    }

    const role = msg.type === 'user' ? 'user' : 'model';
    const parts: Part[] = [];

    // SDK stores content as PartListUnion (array or single part)
    const content = msg.content;
    if (Array.isArray(content)) {
      // Already in parts format
      parts.push(...(content as Part[]));
    } else if (content && typeof content === 'object' && 'text' in content) {
      // Single part with text
      parts.push(content as Part);
    }

    if (parts.length > 0) {
      history.push({ role: role as 'user' | 'model', parts });
    }
  }

  return history;
}
