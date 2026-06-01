/**
 * Safe Message Service Wrapper
 *
 * Provides defensive message creation that gracefully handles
 * sessions deleted during async operations.
 */

import { isForeignKeyConstraintError, shortId } from '@agor/core/db';
import type { Message } from '@agor/core/types';
import type { MessagesService } from '../base/index.js';

/**
 * Safely create a message, handling FK constraint errors gracefully.
 *
 * If the session was deleted between checking and creating, this will
 * catch the FK constraint error and return null instead of crashing.
 *
 * @returns Created message, or null if session no longer exists
 */
export async function safeCreateMessage(
  messagesService: MessagesService,
  message: Message
): Promise<Message | null> {
  try {
    return await messagesService.create(message);
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      console.warn(
        `⚠️  Session ${shortId(message.session_id)} deleted during message creation, skipping`
      );
      return null;
    }
    // Re-throw non-FK errors (actual problems)
    throw error;
  }
}
